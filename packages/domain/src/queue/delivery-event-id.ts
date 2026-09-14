import type { EventType } from '../enums/index.js';

/**
 * delivery-event-id.ts (P11 send-path-mvp, step 2) - the deterministic
 * canonicalisation half of `deliveryEventId(instanceId, publicId, eventType,
 * attemptNo) = sha256(...)`. The app-computed value is written to
 * `delivery_event_ids.provider_event_id` (a `text PRIMARY KEY`) to make the
 * result write idempotent on replay: hashing the SAME four inputs must
 * always reproduce the SAME id, so a crash-and-retry of the same event never
 * inserts a second `delivery_events` row (`a_replayed_result_write_creates_
 * no_second_delivery_event`).
 *
 * `@wp/domain` must run unchanged in a browser and ships no Node builtins
 * (no `node:crypto`) - see `wp/domain-no-wallclock`/domain-purity contract
 * and this package's `build:browser` esbuild target. A real `sha256` needs
 * either Node's `crypto` module or the browser's ASYNC `crypto.subtle`
 * (unusable here: this value is produced synchronously on the send-result
 * write path). This module therefore owns ONLY the pure, deterministic
 * string canonicalisation of the four inputs - `deliveryEventIdInput` - and
 * the actual `sha256(...)` wrapper is applied by the caller in a Node
 * context (app/backend, where `node:crypto` is allowed). See the P11 Unit
 * U1 session report for this split's rationale.
 *
 * Separator choice: `:` cannot appear in `instanceId`/`publicId` (both
 * UUIDs) or in an `EventType` label (fixed enum, snake_case, no colon), so a
 * single `:`-joined string cannot ambiguously collide across a field
 * boundary shift the way plain concatenation could.
 */
export function deliveryEventIdInput(
  instanceId: string,
  publicId: string,
  eventType: EventType,
  attemptNo: number,
): string {
  return `${instanceId}:${publicId}:${eventType}:${String(attemptNo)}`;
}

export type ReceiptEventType = Extract<EventType, 'delivered' | 'read' | 'failed'>;

/** Unit separator (U+001F) - cannot appear in provider-controlled text in practice, and unlike ':' it cannot appear in a participant JID either, so it is safe to join fields that themselves may contain ':'. */
const RECEIPT_ID_SEPARATOR = '';
const RECEIPT_ID_PREFIX = 'receipt:';

/**
 * Blueprint [R-13s]: `provider_event_id = sha256(instance_id ‖ external_id ‖
 * event_type ‖ event_ts ‖ participant_jid)` - participant is included or
 * group receipts (same `wa_msg_id`, different participant) would collide.
 * This is the pure canonicalisation half; `app/backend` applies `sha256` (see
 * `deliveryEventIdInput`'s own doc for why `@wp/domain` cannot hash).
 *
 * `participantJid` defaults to `''` for DMs so callers only supply a value
 * once P24 (groups) exists. `eventTs` is the PROVIDER-supplied timestamp
 * string (`''` when the event carries none) - never the wall clock, so a
 * replayed receipt canonicalises identically on retry.
 *
 * Separator: `deliveryEventIdInput` uses `:` because UUIDs/enum labels
 * cannot contain it - but a participant JID CAN contain `:` (device JIDs
 * like `123:4@s.whatsapp.net`) and `waMsgId` is provider-controlled text, so
 * `:` is not safe here. The unit separator (``) joins the five fields
 * instead, and a `receipt:` prefix keeps this string space from ever
 * colliding with a `deliveryEventIdInput` output.
 */
export function providerEventIdInput(
  instanceId: string,
  waMsgId: string,
  eventType: ReceiptEventType,
  eventTs: string,
  participantJid = '',
): string {
  if (instanceId === '' || waMsgId === '' || (eventType as string) === '') {
    throw new RangeError(
      'providerEventIdInput requires non-empty instanceId, waMsgId and eventType',
    );
  }

  return (
    RECEIPT_ID_PREFIX +
    [instanceId, waMsgId, eventType, eventTs, participantJid].join(RECEIPT_ID_SEPARATOR)
  );
}
