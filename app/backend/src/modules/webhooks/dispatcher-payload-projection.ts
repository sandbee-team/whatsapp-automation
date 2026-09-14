import { REALTIME_PAYLOAD_KEYS, type RealtimePayloadEventType } from '@wp/domain';

/**
 * modules/webhooks/dispatcher-payload-projection.ts (P15 C1 FIX F9 / MAJ-7,
 * sibling split of dispatcher.ts for the 300-line cap - not a behavioural
 * boundary, same idiom as `session-worker-discovery-wiring.ts`) - projects
 * ONLY the event type's own allow-listed keys (`REALTIME_PAYLOAD_KEYS[eventType]`,
 * `@wp/domain` - the SAME allow-list `emit()`/`hub.publish` already enforce
 * at write time) out of the stored `outbox_events.payload` - never the
 * stored payload spread verbatim.
 *
 * An event type this module does not recognise (e.g. the `/test` route's
 * synthetic `webhook.test`, which carries no real business payload) projects
 * to an EMPTY object rather than passing anything through - "no allow-list"
 * means "nothing is allowed", never "everything is allowed".
 *
 * This is the dispatch-time backstop for a payload that reached
 * `outbox_events`/`webhook_deliveries` some OTHER way than `emit()` (a bug,
 * or a future non-`emit()` writer) - defence in depth, not a replacement for
 * `emit()`'s own write-time `assertIdsOnly` gate.
 */
export function projectAllowedPayload(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const allowedKeys = REALTIME_PAYLOAD_KEYS[eventType as RealtimePayloadEventType] as
    readonly string[] | undefined;
  if (allowedKeys === undefined) {
    return {};
  }
  const projected: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (key in payload) {
      projected[key] = payload[key];
    }
  }
  return projected;
}
