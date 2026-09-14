import { randomUUID } from 'node:crypto';
import type { TenantDb } from '@wp/db';
import type { SendOrigin } from '@wp/domain';
import { enqueueMessageJob } from '../../messages/index.js';

/**
 * system-send.ts (P14 Unit U4, step 5; FINDING 7 FIX, P14 review-fix F2) -
 * the ONLY module where the exempt `SendOrigin` uppercase identifiers live
 * (`scripts/check-send-origin.ts` clause (a) - every OTHER file in the tree
 * must use the lowercase string literals). `sendOptOutConfirmation` is the
 * production `onOptedOut` port binding the P21 inbound handler invokes with
 * `detectInboundOptOut`'s (`modules/inbound/optout-detect.ts`) returned
 * `result.optedOut` descriptor, strictly AFTER that handler's own
 * transaction has committed - never from inside it (that module no longer
 * calls this port itself; see its own "FINDING 7" doc for why).
 *
 * DURABLE-FIRST (core invariant 1): the confirmation is a real
 * `message_jobs` row via `enqueueMessageJob` (the SAME insert path
 * `messages.service.ts` uses for a tenant send) - there is no second,
 * ad-hoc internal insert. It is written in the SAME `withTenant`
 * transaction as the 30-day guard upsert below, so a crash after the guard
 * row updates but before the job commits rolls BOTH back together (the
 * guard is never "already sent" while the job never actually exists).
 *
 * 30-DAY GUARD: `optout_confirmations` (migration 0036) PK
 * (client_id, scope_key, phone_hash) - `scope_key` is bound to `clientId`
 * itself (client-scoped confirmations, matching `opt_outs`' own
 * `scope='client'` default this phase uses everywhere else). The
 * `ON CONFLICT ... DO UPDATE ... WHERE last_sent_at < now() - interval
 * '30 days' RETURNING 1` shape means: no row back = a confirmation already
 * went out within 30 days = SKIP (no job enqueued); a row back = either the
 * FIRST-EVER confirmation for this phone_hash (INSERT branch) or a
 * legitimately-stale one being refreshed (UPDATE branch) = enqueue.
 */

export const SYSTEM_REPLY: SendOrigin = 'system_reply';
export const OPT_OUT_CONFIRMATION: SendOrigin = 'opt_out_confirmation';

/** Placeholder confirmation copy - a later unit centralises the real tenant-facing copy (task instruction, verbatim). */
const OPT_OUT_CONFIRMATION_BODY =
  "You've been unsubscribed and will no longer receive messages from this number.";

export interface SendOptOutConfirmationInput {
  clientId: string;
  instanceId: string;
  phoneHash: Buffer;
  e164: string;
}

export interface SendOptOutConfirmationDeps {
  tenantDb: TenantDb;
}

export interface SendOptOutConfirmationResult {
  /**
   * `false` when the 30-day guard skipped this call (a confirmation
   * already went out within the window) OR when the guard passed but the
   * underlying job insert itself matched an existing idempotency key (a
   * same-calendar-day replay, `confirmationIdempotencyKey`'s own doc) - in
   * either case nothing NEW was created. `true` only when a genuinely new
   * `message_jobs` row was inserted this call - a normal, idempotent
   * no-op either way, never an error.
   */
  enqueued: boolean;
}

/** `message_jobs.recipient_jid` for a contact - mirrors `messages.routes-support.ts#recipientColumnsFor`'s own E.164-to-JID shape (that helper lives in a module this internal path never imports, per layering - reproduced here at the one call site that needs it). */
function jidFromE164(e164: string): string {
  return `${e164.replace(/^\+/u, '')}@s.whatsapp.net`;
}

/** `message_job_refs.idempotency_key` for this phone_hash's confirmation THIS local calendar day - a repeat call the same day (e.g. a retried inbound webhook) replays the same job, never a duplicate. */
function confirmationIdempotencyKey(phoneHash: Buffer, now: Date): string {
  const localDate = now.toISOString().slice(0, 10);
  return `optout-confirm:${phoneHash.toString('hex')}:${localDate}`;
}

export async function sendOptOutConfirmation(
  deps: SendOptOutConfirmationDeps,
  input: SendOptOutConfirmationInput,
): Promise<SendOptOutConfirmationResult> {
  return deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const guard = await tx.query(
      `INSERT INTO optout_confirmations (client_id, scope_key, phone_hash, last_sent_at)
       VALUES ($1, $1, $2, now())
       ON CONFLICT (client_id, scope_key, phone_hash)
       DO UPDATE SET last_sent_at = now()
         WHERE optout_confirmations.last_sent_at < now() - interval '30 days'
       RETURNING 1
       -- client_id = $1`,
      [input.clientId, input.phoneHash],
    );
    if (guard.rowCount === 0 || guard.rowCount === null) {
      return { enqueued: false };
    }

    const now = new Date();
    const requestBody = {
      kind: 'opt_out_confirmation',
      phoneHash: input.phoneHash.toString('hex'),
    };
    const enqueued = await enqueueMessageJob(tx, {
      clientId: input.clientId,
      instanceId: input.instanceId,
      idempotencyKey: confirmationIdempotencyKey(input.phoneHash, now),
      requestHash: Buffer.from(JSON.stringify(requestBody), 'utf8'),
      recipient: { jid: jidFromE164(input.e164), e164: input.e164 },
      recipientHash: input.phoneHash,
      sendOrigin: OPT_OUT_CONFIRMATION,
      payload: { text: OPT_OUT_CONFIRMATION_BODY },
      payloadKind: 'text',
      priority: 'high',
      scheduledAt: null,
    });

    await tx.query(
      `INSERT INTO pacing_events (id, client_id, instance_id, kind, to_value, evidence)
       VALUES ($1, $2, $3, 'SYSTEM_SEND', $4, $5)
       -- client_id = $2`,
      [
        randomUUID(),
        input.clientId,
        input.instanceId,
        JSON.stringify({ sendOrigin: OPT_OUT_CONFIRMATION }),
        JSON.stringify({ decision: 'exempt_system_send', messageJobCreated: enqueued.created }),
      ],
    );

    return { enqueued: enqueued.created };
  });
}

export interface OnOptedOutPort {
  (input: { clientId: string; instanceId: string; phoneHash: Buffer; e164: string }): void;
}

/**
 * Structured logger port for a failed confirmation send (P14 fix round F3
 * finding 4) - ids + error class only. `error_class` (not e.g. `err_name`)
 * is the one field name `@wp/server-kit`'s `WpLogger`/`ALLOWED_LOG_FIELDS`
 * sanitizer actually keeps (`send-loop-fleet-wiring.ts` binds the same
 * field name for the same reason).
 */
export interface SystemSendLogger {
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Returns the `onOptedOut` port shape a P21 inbound handler binds and calls
 * itself with `detectInboundOptOut`'s returned `result.optedOut`, strictly
 * AFTER that handler's own transaction commits (FINDING 7 - `optout-
 * detect.ts` no longer invokes any port itself). Fires-and-forgets
 * `sendOptOutConfirmation` (this port is synchronous/void, mirroring its
 * former in-module contract) - a rejected promise is logged, never thrown
 * back into the inbound-message handling path (an opt-out CONFIRMATION
 * failure must never fail the opt-out itself, which has already committed
 * by the time this port fires).
 *
 * The failure log is ids + error class ONLY (P14 fix round F3 finding 4) -
 * a raw `console.error(err)` previously risked leaking the recipient's E.164
 * via a Postgres constraint error's `detail` field; `input.e164` itself is
 * never read here.
 */
export function bindOptOutConfirmationSender(
  deps: SendOptOutConfirmationDeps,
  logger: SystemSendLogger,
): OnOptedOutPort {
  return (input) => {
    sendOptOutConfirmation(deps, input).catch((err: unknown) => {
      logger.error('sendOptOutConfirmation failed', {
        client_id: input.clientId,
        instance_id: input.instanceId,
        error_class: err instanceof Error ? err.name : 'UnknownError',
      });
    });
  };
}
