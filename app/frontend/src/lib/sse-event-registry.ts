import type { RealtimeEvent } from '@wp/contracts';

/**
 * lib/sse-event-registry.ts (P08 U7, split out of `sse.ts` for the
 * workspace's 300-line max-lines lint rule) - the typed per-event-type
 * listener registry, additive to the static `lib/sse-invalidation-map.ts`
 * query-key invalidation: some surfaces (the Connect sheet's live
 * QR/pairing-code panel) need the event's OWN fields (e.g. `instance.qr`'s
 * `payload`, `expiresAt`, `attemptsLeft`), not just "a cache key changed, go
 * refetch" - those fields are never cached in react-query (canon: the
 * client never trusts a frame's payload as long-lived data), so a direct
 * subscription is the only way to reach them. Invoked from the SAME parse
 * path as the invalidation map (`sse-stream-consumer.ts`'s `consumeStream`,
 * via `sse.ts`'s `connectOnce`) - it never re-parses frames itself, and
 * unknown event types never reach here at all (dropped upstream by
 * `isKnownRealtimeEventType`).
 */
type RealtimeEventListener<T extends RealtimeEvent['type']> = (
  event: Extract<RealtimeEvent, { type: T }>,
) => void;

const eventListeners = new Map<RealtimeEvent['type'], Set<(event: RealtimeEvent) => void>>();

/**
 * Subscribes to every `RealtimeEvent` of the given `type` for as long as the
 * stream stays open. Returns an unsubscribe function; calling it more than
 * once is a no-op-safe no-op (removing an already-removed callback is a
 * harmless `Set.delete` on a Set that no longer has it).
 */
export function subscribeRealtimeEvent<T extends RealtimeEvent['type']>(
  type: T,
  cb: RealtimeEventListener<T>,
): () => void {
  let listeners = eventListeners.get(type);
  if (!listeners) {
    listeners = new Set();
    eventListeners.set(type, listeners);
  }
  const wrapped = cb as (event: RealtimeEvent) => void;
  listeners.add(wrapped);

  return () => {
    listeners?.delete(wrapped);
  };
}

/** Dispatches one parsed, already-known-type event to every subscriber of its type. */
export function dispatchRealtimeEvent(event: RealtimeEvent): void {
  const listeners = eventListeners.get(event.type);
  if (!listeners) return;
  for (const listener of listeners) {
    listener(event);
  }
}
