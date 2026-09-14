import { createHash } from 'node:crypto';
import {
  deliveryEventIdInput,
  providerEventIdInput,
  type EventType,
  type ReceiptEventType,
} from '@wp/domain';
import type { TenantQueryable } from '@wp/db';

/**
 * delivery-event.ts (P11 Unit U4; C1 CRITICAL fix) - the Node-side half of
 * the deliverable event id (`@wp/domain`'s `deliveryEventIdInput` owns only
 * the pure canonicalisation - see that module's own doc comment for why the
 * sha256 wrapper cannot live in `packages/domain`). One place, reused by
 * both `dispatch.ts` and `result.ts` rather than inlined at each call site
 * (task requirement).
 *
 * `writeDeliveryEvent` is the write-order-normative pair (migration 0009
 * header): INSERT `delivery_event_ids` FIRST, then INSERT `delivery_events`,
 * in the SAME transaction - a replay's dedupe insert on the first table is
 * what makes the whole pair a no-op (`a_replayed_result_write_creates_no_
 * second_delivery_event`).
 *
 * CRITICAL FIX: the dedupe insert uses `ON CONFLICT (provider_event_id) DO
 * NOTHING` (`provider_event_id` is the PK - migration 0008) and branches on
 * `rowCount`, rather than letting Postgres raise 23505 and catching it. `tx`
 * here is ALWAYS a raw `pg` client already inside an open `BEGIN`
 * (`db/src/tenant-db.ts`), with no savepoint - in Postgres ANY error aborts
 * the ENTIRE transaction, every later statement fails 25P02, and COMMIT
 * silently degrades to ROLLBACK while the client library reports success.
 * `writeDeliveryEvent` is the LAST statement of `resolveAck`'s second
 * transaction (`result.ts`) - a duplicate `provider_event_id` there
 * (replay, reaper re-drive, two workers racing) would previously discard
 * `status='sent'`, `sent_at`, AND the `message_wa_ids` row from that same
 * transaction, while `resolveAck` itself returned normally - a silent
 * double-send. `ON CONFLICT DO NOTHING` never raises, so the surrounding
 * transaction is never put into an aborted state by a duplicate alone.
 */

export function deliveryEventId(
  instanceId: string,
  publicId: string,
  eventType: EventType,
  attemptNo: number,
): string {
  return createHash('sha256')
    .update(deliveryEventIdInput(instanceId, publicId, eventType, attemptNo))
    .digest('hex');
}

/**
 * P21 Unit U3 - the receipt-path sibling of `deliveryEventId`: sha256 of
 * `@wp/domain`'s pure `providerEventIdInput` canonicalisation (blueprint
 * [R-13s]). Same package-boundary reason as `deliveryEventId` itself - see
 * `providerEventIdInput`'s own doc for why `@wp/domain` cannot hash.
 */
export function receiptProviderEventId(
  instanceId: string,
  waMsgId: string,
  eventType: ReceiptEventType,
  eventTs: string,
  participantJid = '',
): string {
  return createHash('sha256')
    .update(providerEventIdInput(instanceId, waMsgId, eventType, eventTs, participantJid))
    .digest('hex');
}

export interface WriteDeliveryEventInput {
  clientId: string;
  instanceId: string;
  messageJobId: string;
  /** A JS `Date` (send path) or the `::text` literal of `message_jobs.created_at` (receipt path, P21) - pg truncates a round-tripped timestamptz to ms, so a caller that must equality-match a `now()`-sourced row passes the text. */
  messageJobCreatedAt: Date | string;
  eventType: EventType;
  providerEventId: string;
}

/**
 * Writes the `delivery_event_ids` + `delivery_events` pair. Returns
 * `{inserted: false}` (never throws) when `providerEventId` was already
 * recorded - a replay of the same result write - so callers can treat a
 * duplicate as the expected idempotent no-op rather than a hard failure.
 */
export async function writeDeliveryEvent(
  tx: TenantQueryable,
  input: WriteDeliveryEventInput,
): Promise<{ inserted: boolean }> {
  const dedupeInsert = await tx.query(
    `INSERT INTO delivery_event_ids (provider_event_id, client_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider_event_id) DO NOTHING
     -- client_id = $2`,
    [input.providerEventId, input.clientId, input.messageJobId, input.messageJobCreatedAt],
  );
  if (dedupeInsert.rowCount === 0) {
    // Already recorded - a replay. Never throws, never touches the
    // transaction's error state (ON CONFLICT DO NOTHING raises nothing),
    // so every earlier statement in this same transaction survives to
    // COMMIT.
    return { inserted: false };
  }

  await tx.query(
    `INSERT INTO delivery_events
       (client_id, instance_id, message_job_id, message_job_created_at, event_type, provider_event_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     -- client_id = $1`,
    [
      input.clientId,
      input.instanceId,
      input.messageJobId,
      input.messageJobCreatedAt,
      input.eventType,
      input.providerEventId,
    ],
  );

  return { inserted: true };
}
