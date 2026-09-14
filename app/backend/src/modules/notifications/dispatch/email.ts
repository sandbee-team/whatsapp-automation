import { NOTIFICATION_COPY } from '@wp/domain';
import type { NotificationKind } from '@wp/domain';
import { logger } from '@wp/server-kit';
import type { Mailer } from '../../../platform/mailer.js';
import { tenantKey } from '../../../platform/redis.js';
import { bindNotificationMetrics } from '../../../platform/metrics/notification-metrics.js';

/**
 * modules/notifications/dispatch/email.ts (P17 U3, step 4) - the relay's
 * EMAIL leg: for every claimed outbox row whose `fanout` includes `'email'`,
 * loads the source `notifications` row (`wp_relay` has SELECT, migration
 * 0048), resolves recipients via the SECURITY DEFINER
 * `wp_notification_email_recipients($clientId)` (migration 0049, `wp_relay`
 * EXECUTE-only - table-level `memberships`/`users` access is deliberately
 * NEVER granted to `wp_relay`, see 0048's own "WP_RELAY GAP" header) and,
 * when `instance_id` is set, `wp_notification_instance_label($clientId,
 * $instanceId)`, renders the kind's `NOTIFICATION_COPY.email` with
 * placeholders filled from the notification's own payload plus the resolved
 * label, and sends ONE email (all recipients on one message) through the
 * EXISTING `platform/mailer.ts` `Mailer` port - never a second transport.
 *
 * RELAY-SIDE I/O, NEVER INSIDE ANY BUSINESS OR OUTBOX TRANSACTION (P17 fix
 * round F1, CORRECTED after re-review - CRITICAL): `relay-loop.ts` calls
 * `dispatchEmails` ONLY AFTER its own `withRelayRole` transaction has already
 * COMMITTED (claim + mark-published for every fanout, including email,
 * happens inside that tx; the actual SMTP send never does). The F1 fix's
 * FIRST attempt still wrapped the SMTP calls in a DIFFERENT, freshly-opened
 * transaction (`modules/notifications/dispatch/relay-email-fanout.ts`'s own `BEGIN`/`SET LOCAL ROLE`)
 * - still wrong: a batch of SMTP round-trips (worst case nodemailer's ~2min
 * TCP timeout per unreachable-host row) then pins that `wp_relay` connection
 * idle-in-transaction, which can block `VACUUM` on `outbox_events`/
 * `notifications`. The CORRECTED split: `resolve(client, rows)` runs ONLY
 * the two `client.query` reads (recipient/instance-label resolution) INSIDE
 * a short transaction, which then COMMITS and releases the connection
 * BEFORE any SMTP call ever happens; `send(resolved)` then runs the cap
 * check + `mailer.sendNotificationEmail` + per-row isolation with NO
 * database connection held at all - matching `platform/mailer.ts`'s own
 * binding contract ("a mailer call must NEVER happen inside a DB
 * transaction") and `dispatcher.ts`'s HTTP leg precedent (`dispatchOne` does
 * its network call BEFORE re-entering `withRelayRole`).
 *
 * HONEST DELIVERY CONTRACT: email is AT-MOST-ONCE BY DESIGN, never
 * at-least-once. The outbox row is marked published (inside the commit)
 * BEFORE this dispatch ever runs, so a crash between that commit and the
 * actual SMTP send loses ONLY that one email - it is never retried, and
 * never resent on a later tick. This is a deliberate, bounded trade-off: the
 * DURABLE, MANDATORY notification channels are in-app (the `notifications`
 * row itself, already committed) and webhook (which IS at-least-once via its
 * own durable `webhook_deliveries` retry queue) - email is a best-effort
 * convenience leg layered on top, never a channel a caller may treat as
 * having a delivery promise. (Worded to avoid check-copy's banned-claim
 * tokens - the guard scans this file too, and rightly so.)
 *
 * PER-ROW ISOLATION (F1): `send`'s loop wraps EACH resolved row in its own
 * try/catch - one row's SMTP throw (or any other per-row failure) is
 * swallowed, logged (a static message + `error_class` only - NEVER
 * `err.message`, which for an SMTP rejection routinely embeds the recipient
 * address, e.g. "550 5.1.1 <user@example.com>... User unknown" - same
 * redaction precedent as `signup.service.ts`'s own verification-email
 * failure log), and counted via `wp_notification_email_failures_total{kind}`;
 * it NEVER stops the rest of the batch and NEVER throws back into the
 * relay's own drain tick (which, by the time this runs, has already
 * committed - there is no tick left to poison).
 *
 * PER-CLIENT HOURLY CAP (phase step 4, verbatim: "per-client cap 20
 * emails/hour"): a Redis `INCR` + `EXPIRE 3600` counter, keyed per client -
 * incremented on every row this dispatch attempts to send for that client,
 * REGARDLESS of whether the send itself later succeeds or fails (see
 * `CAP_WINDOW_SECONDS`'s own doc comment / F4: this is a deliberate
 * INCR-always policy, not a bug - the counter cannot lock a client out,
 * since its TTL anchors at the FIRST increment this hour, and it still
 * enforces "at most 20 send ATTEMPTS per hour", the cap's actual purpose). A
 * row that resolves to ZERO recipients never increments it at all, since no
 * send is even attempted. At/over the cap, `send` does NOT call the mailer
 * at all - it increments `wp_notification_emails_suppressed_total{kind}` and
 * returns, and the caller (relay-loop.ts) still marks the outbox row
 * published regardless (the row's own SSE/webhook siblings are SEPARATE rows
 * and are NEVER capped - only this row, this channel, is ever affected).
 *
 * NEVER LOGS A RECIPIENT ADDRESS (P04a S2 precedent) - every log line this
 * module could emit stays scoped to notification id / client id / kind, no
 * `email` field ever reaches a log call.
 */

const HOURLY_CAP = 20;
const CAP_WINDOW_SECONDS = 3600;

export interface EmailRecipient {
  userId: string;
  email: string;
}

export interface NotificationEmailRow {
  id: string;
  clientId: string;
  instanceId: string | null;
  kind: NotificationKind;
  payload: Record<string, unknown>;
}

/** Minimal query surface this dispatch needs on a `RelayPoolClient` - a structural subset, never `pg.PoolClient` by name (mirrors `relay-loop.ts`'s own `RelayPoolClient`). */
export interface EmailQueryClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/** One row's DB-resolved shape - the output of `resolve()`, the input to `send()`. Carries everything `send()` needs so it never touches `EmailQueryClient` again. */
export interface ResolvedEmail {
  row: NotificationEmailRow;
  recipients: EmailRecipient[];
  instanceLabel: string | null;
}

/** The per-client hourly-cap counter - `platform/redis.ts`'s `createRedis` in production, a fake in tests (never real sleeping/timing - see this module's own tests). */
export interface EmailCapCounter {
  /** Atomically increments the client's this-hour counter (creating it with a 1-hour TTL on first use) and returns the NEW count. */
  incrementAndGet(clientId: string): Promise<number>;
}

/**
 * The split port (coordinator correction, CRITICAL): `resolve` runs ONLY
 * the two DB reads, inside the caller's short-lived `wp_relay`-scoped
 * transaction (module doc's own "RELAY-SIDE I/O" section); `send` runs
 * afterwards, with NO database connection/transaction held at all - the cap
 * check and every `mailer.sendNotificationEmail` call live here.
 */
export interface EmailDispatchPort {
  resolve(client: EmailQueryClient, rows: NotificationEmailRow[]): Promise<ResolvedEmail[]>;
  send(resolved: ResolvedEmail[]): Promise<void>;
}

export interface EmailDispatchDeps {
  mailer: Mailer;
  capCounter: EmailCapCounter;
  /** `resolveRedisUrl`'s own `env` segment (`tenantKey(env, clientId, ...)`) - matches `redis-bridge.ts`'s own `env` field. */
  env: string;
}

function fillPlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

async function loadNotification(
  client: EmailQueryClient,
  row: NotificationEmailRow,
): Promise<{ instanceLabel: string | null }> {
  if (!row.instanceId) {
    return { instanceLabel: null };
  }
  const result = await client.query<{ label: string | null }>(
    'SELECT wp_notification_instance_label($1, $2) AS label',
    [row.clientId, row.instanceId],
  );
  return { instanceLabel: result.rows[0]?.label ?? null };
}

async function loadRecipients(
  client: EmailQueryClient,
  clientId: string,
): Promise<EmailRecipient[]> {
  const result = await client.query<{ user_id: string; email: string }>(
    'SELECT user_id, email FROM wp_notification_email_recipients($1)',
    [clientId],
  );
  return result.rows.map((r) => ({ userId: r.user_id, email: r.email }));
}

/** One row's own send - split out so the per-row try/catch in `send` below wraps a single, clearly-bounded unit of work. NO `EmailQueryClient` parameter - every DB read this needs already happened in `resolve()`. */
async function sendOneRow(
  deps: EmailDispatchDeps,
  metrics: ReturnType<typeof bindNotificationMetrics>,
  resolved: ResolvedEmail,
): Promise<void> {
  const { row, recipients, instanceLabel } = resolved;
  if (recipients.length === 0) {
    return;
  }

  const copy = NOTIFICATION_COPY[row.kind].email;
  const values: Record<string, string> = {
    instanceLabel: instanceLabel ?? '',
    queued: String(row.payload['queued'] ?? ''),
    tier: String(row.payload['tier'] ?? ''),
    day: String(row.payload['day'] ?? ''),
  };
  const subject = fillPlaceholders(copy.subject, values);
  const body = fillPlaceholders(copy.body, values);

  const capKey = tenantKey(deps.env, row.clientId, 'notify', 'email', 'hourly');
  const newCount = await deps.capCounter.incrementAndGet(capKey);
  if (newCount > HOURLY_CAP) {
    metrics.incrementEmailsSuppressed(row.kind);
    return;
  }

  await deps.mailer.sendNotificationEmail(
    recipients.map((r) => r.email),
    subject,
    body,
  );
}

/** Creates the production `EmailDispatchPort`. */
export function createEmailDispatchPort(deps: EmailDispatchDeps): EmailDispatchPort {
  const metrics = bindNotificationMetrics();

  return {
    async resolve(client, rows) {
      const resolved: ResolvedEmail[] = [];
      for (const row of rows) {
        const recipients = await loadRecipients(client, row.clientId);
        const { instanceLabel } = await loadNotification(client, row);
        resolved.push({ row, recipients, instanceLabel });
      }
      return resolved;
    },

    async send(resolved) {
      for (const item of resolved) {
        try {
          await sendOneRow(deps, metrics, item);
        } catch (err) {
          // PER-ROW ISOLATION (F1) - never rethrown: by the time this runs,
          // the relay's own drain tick has already committed (module doc),
          // so there is no tick left to poison. NEVER logs `err.message` -
          // an SMTP rejection routinely embeds the recipient address (e.g.
          // "550 5.1.1 <user@example.com>... User unknown", coordinator
          // finding). A static message + `error_class` only (same
          // {name, code} shape as `signup.service.ts`'s own verification-
          // email failure log - folded into ONE `error_class` string here
          // since the structured `logger`'s `LogFields` allow-list has no
          // separate error-code field; `signup.service.ts` uses a bare
          // `console.error`, not the allow-listed logger, so it can carry
          // two fields, this call site carries one).
          const errName = err instanceof Error ? err.name : 'UnknownError';
          const errCode = (err as { code?: unknown } | null)?.code;
          const errorClass = errCode !== undefined ? `${errName}:${String(errCode)}` : errName;
          metrics.incrementEmailFailures(item.row.kind);
          logger.warn(
            {
              client_id: item.row.clientId,
              instance_id: item.row.instanceId ?? undefined,
              error_class: errorClass,
            },
            `dispatch/email: send failed for one row, continuing the batch (at-most-once by design)`,
          );
        }
      }
    },
  };
}

export { HOURLY_CAP, CAP_WINDOW_SECONDS };
