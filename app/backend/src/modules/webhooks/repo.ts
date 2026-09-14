import type { RelayPoolClient, WebhookFanoutPort, ClaimedWebhookRow } from '../events/index.js';
import { createHash } from 'node:crypto';

/**
 * repo.ts (P15 U5, step 7) - SQL against `webhook_endpoints`/
 * `webhook_deliveries`, split into two callers:
 *   - `createWebhookFanoutPort` - the relay-loop seam implementation
 *     (`WebhookFanoutPort`), run on the relay's OWN `wp_relay`-scoped
 *     transaction (migration 0041/0042 grants).
 *   - the dispatcher's own claim/mark-sent/mark-failed/health-tracking
 *     helpers, run on the dispatcher LOOP's own `wp_relay`-scoped
 *     connection (a SEPARATE tick from the drain tick - see dispatcher.ts).
 *
 * No RLS-scoped (`wp_app`) queries live here - every statement in this file
 * is cross-tenant by construction (the dispatcher polls ALL tenants'
 * pending deliveries each tick, same as the drain loop), matching
 * `modules/events/relay-loop.ts`'s own access shape exactly.
 */

/** sha256 of the JSON-stringified payload - `webhook_deliveries.payload_hash`, a receiver-facing content fingerprint (never the payload itself - the row only stores ids/enums via the JOIN to `outbox_events.payload` at claim time, not a duplicate copy). */
export function hashPayload(payload: Record<string, unknown>): Buffer {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest();
}

/**
 * The relay-loop fanout seam: for each claimed webhook-fanned row, finds
 * every ENABLED endpoint subscribed to that row's `event_type`
 * (`events @> ARRAY[$event_type]`) and inserts one `pending`
 * `webhook_deliveries` row per (event, endpoint) pair. `ON CONFLICT
 * (outbox_event_id, endpoint_id) DO NOTHING` makes this idempotent against a
 * reclaim/retry of the SAME outbox row (the unique index is the storage-
 * layer authority, migration 0041) - never a duplicate delivery row for one
 * (event, endpoint) pair.
 */
export function createWebhookFanoutPort(): WebhookFanoutPort {
  return {
    async writeDeliveries(client: RelayPoolClient, rows: ClaimedWebhookRow[]): Promise<void> {
      for (const row of rows) {
        const payloadHash = hashPayload(row.payload);
        await client.query(
          `INSERT INTO webhook_deliveries
             (client_id, outbox_event_id, endpoint_id, event_type, payload_hash, status, next_attempt_at)
           SELECT $1, $2, e.id, $3, $4, 'pending', now()
             FROM webhook_endpoints e
            WHERE e.client_id = $1
              AND e.enabled = true
              AND e.events @> ARRAY[$3]::text[]
           ON CONFLICT (outbox_event_id, endpoint_id) DO NOTHING`,
          [row.clientId, row.outboxEventId, row.eventType, payloadHash],
        );
      }
    },
  };
}

export interface ClaimedDeliveryRow {
  id: string;
  clientId: string;
  endpointId: string;
  outboxEventId: string;
  eventType: string;
  attempt: number;
  url: string;
  secretEnc: Buffer;
  eventPayload: Record<string, unknown>;
}

/**
 * BUG FIX (P15 C2 hardening pass): claims up to `limit` due
 * (`next_attempt_at <= now()`), still-`pending` deliveries as ONE atomic
 * conditional write - a CTE that `SELECT ... FOR UPDATE SKIP LOCKED`s the
 * candidate rows and, in the SAME statement, `UPDATE`s each claimed row's
 * `next_attempt_at` forward by `CLAIM_VISIBILITY_MS` (a claim-visibility
 * timeout, same shape `scheduleDeliveryRetry` already uses for its own
 * `next_attempt_at` writes - no new `status` value, no migration: the
 * existing `pending -> sent|failed` CHECK is untouched).
 *
 * Was previously a bare `SELECT ... FOR UPDATE OF d SKIP LOCKED` with NO
 * write - `withRelayRole` commits (releasing every row lock) as soon as the
 * SELECT returns, before any HTTP dispatch ever runs, so a row stayed
 * `status='pending', next_attempt_at <= now()` and thus visible to a second,
 * genuinely concurrent `runDispatchTick` call for the whole dispatch
 * duration - `two_relay_processes_publish_each_event_exactly_once`-shaped
 * concurrency but WITHOUT the mark-published-in-the-same-tx discipline that
 * makes that test pass for the drain loop. Proven by
 * `dispatcher-concurrent-disable.integration.test.ts`
 * (`twenty_concurrently_claimed_terminal_failures_disable_the_endpoint_exactly_once`):
 * every one of 20 deliveries reached `attempt=2` (double-dispatched, one
 * real HTTP POST per tick) before this fix.
 *
 * Joined to the owning endpoint's `url`/`secret_enc` and the source
 * `outbox_events.payload` (the actual body to sign+send). Ordered oldest-due
 * first - same no-starvation discipline as every other claim query in this
 * schema.
 */
const CLAIM_VISIBILITY_MS = 60_000;

export async function claimDueDeliveries(
  client: RelayPoolClient,
  limit: number,
): Promise<ClaimedDeliveryRow[]> {
  const result = await client.query<{
    id: string;
    client_id: string;
    endpoint_id: string;
    outbox_event_id: string;
    event_type: string;
    attempt: number;
    url: string;
    secret_enc: Buffer;
    payload: Record<string, unknown>;
  }>(
    `WITH claimed AS (
       SELECT id FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT $1
          FOR UPDATE SKIP LOCKED
     ),
     bumped AS (
       UPDATE webhook_deliveries d SET next_attempt_at = now() + ($2 || ' milliseconds')::interval
         FROM claimed
        WHERE d.id = claimed.id
        RETURNING d.id, d.client_id, d.endpoint_id, d.outbox_event_id, d.event_type, d.attempt
     )
     SELECT b.id, b.client_id, b.endpoint_id, b.outbox_event_id, b.event_type, b.attempt,
            e.url, e.secret_enc, o.payload
       FROM bumped b
       JOIN webhook_endpoints e ON e.id = b.endpoint_id
       JOIN outbox_events o ON o.id = b.outbox_event_id
      ORDER BY b.id`,
    [limit, CLAIM_VISIBILITY_MS],
  );
  return result.rows.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    endpointId: row.endpoint_id,
    outboxEventId: row.outbox_event_id,
    eventType: row.event_type,
    attempt: row.attempt,
    url: row.url,
    secretEnc: row.secret_enc,
    eventPayload: row.payload,
  }));
}

/** Records a successful (2xx) attempt: `status='sent'`, increments `attempt`, stores `status_code`. Never retried again. */
export async function markDeliverySent(
  client: RelayPoolClient,
  deliveryId: string,
  statusCode: number,
): Promise<void> {
  await client.query(
    `UPDATE webhook_deliveries SET status = 'sent', attempt = attempt + 1, status_code = $2,
       error_class = NULL, updated_at = now()
      WHERE id = $1`,
    [deliveryId, statusCode],
  );
}

/** Schedules the next retry: `attempt` incremented, `next_attempt_at` set from the caller's own backoff computation, stays `pending`. */
export async function scheduleDeliveryRetry(
  client: RelayPoolClient,
  deliveryId: string,
  input: { statusCode: number | null; errorClass: string; nextAttemptAt: Date },
): Promise<void> {
  await client.query(
    `UPDATE webhook_deliveries SET attempt = attempt + 1, status_code = $2, error_class = $3,
       next_attempt_at = $4, updated_at = now()
      WHERE id = $1`,
    [deliveryId, input.statusCode, input.errorClass, input.nextAttemptAt],
  );
}

/** Marks a delivery terminally `failed` - a terminal status class, or `MAX_ATTEMPTS` exhausted. Never retried again. */
export async function markDeliveryFailed(
  client: RelayPoolClient,
  deliveryId: string,
  input: { statusCode: number | null; errorClass: string },
): Promise<void> {
  await client.query(
    `UPDATE webhook_deliveries SET status = 'failed', attempt = attempt + 1, status_code = $2,
       error_class = $3, updated_at = now()
      WHERE id = $1`,
    [deliveryId, input.statusCode, input.errorClass],
  );
}

export interface EndpointHealthRow {
  consecutiveFailures: number;
  enabled: boolean;
}

/** One success resets `consecutive_failures` to 0 and stamps `last_success_at`. */
export async function recordEndpointSuccess(
  client: RelayPoolClient,
  endpointId: string,
): Promise<void> {
  await client.query(
    `UPDATE webhook_endpoints SET consecutive_failures = 0, last_success_at = now()
      WHERE id = $1`,
    [endpointId],
  );
}

/**
 * Increments `consecutive_failures` on a TERMINAL failure only (a retry that
 * will be attempted again is not yet a "failure" for this counter's
 * purpose) and returns the row's new count plus whether it just crossed the
 * disable threshold. Never touches `enabled` itself - the caller
 * (dispatcher.ts) decides whether to disable and writes that + the audit
 * row + the outbox event as one explicit follow-up step.
 */
export async function incrementEndpointFailures(
  client: RelayPoolClient,
  endpointId: string,
): Promise<EndpointHealthRow> {
  const result = await client.query<{ consecutive_failures: number; enabled: boolean }>(
    `UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1
      WHERE id = $1
      RETURNING consecutive_failures, enabled`,
    [endpointId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`incrementEndpointFailures: no such endpoint ${endpointId}`);
  return { consecutiveFailures: row.consecutive_failures, enabled: row.enabled };
}

/** Disables an endpoint at the consecutive-failure threshold - `enabled=false`, `disabled_reason='consecutive_failures'`. Idempotent (a repeat call on an already-disabled endpoint is a harmless no-op UPDATE). */
export async function disableEndpointForConsecutiveFailures(
  client: RelayPoolClient,
  endpointId: string,
): Promise<void> {
  await client.query(
    `UPDATE webhook_endpoints SET enabled = false, disabled_reason = 'consecutive_failures'
      WHERE id = $1`,
    [endpointId],
  );
}
