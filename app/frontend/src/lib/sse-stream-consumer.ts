import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { RealtimeEvent } from '@wp/contracts';
import { batchFrameSchema } from '@wp/contracts';
import { createSseFrameParser } from './sse-frame-parser.js';
import {
  invalidateForRealtimeEvent,
  isKnownRealtimeEventType,
  queryKeysForRealtimeEvent,
} from './sse-invalidation-map.js';

/**
 * lib/sse-stream-consumer.ts (P05 FIXA, split out of sse.ts for the
 * workspace's 300-line max-lines lint rule) - `consumeStream`, the pure
 * per-frame handling logic for one open SSE response body: heartbeat/resync
 * handling, JSON parse + static query-key invalidation via
 * `sse-invalidation-map.ts` (canon: "the client receives a hint and refetches
 * over the authorized API", never trusts the frame's payload as data).
 *
 * Deliberately parameterized rather than reaching into `sse.ts`'s
 * module-level `shared` singleton directly: `onFrameId` and the optional
 * `onEvent` are the ONLY hooks back into the caller's mutable state, keeping
 * this file's identity-guard responsibility (see sse.ts's own doc comment on
 * why `shared === mine` matters) entirely the caller's concern, not
 * duplicated here. `onEvent` (P08 U7) additionally feeds `sse.ts`'s typed
 * `subscribeRealtimeEvent` listener registry, fired AFTER the static
 * invalidation map so registry subscribers never race a stale cache read.
 *
 * `batch` frame handling (P15 U6, step 9): the outbox relay coalesces up to
 * 25 events per (client, instance) tick into ONE `batch` frame
 * (`@wp/contracts`'s `batchFrameSchema`). This never re-parses each event
 * through the single-event path - it collects the query-key SET each named
 * event maps to (via `queryKeysForRealtimeEvent`, the same static map
 * `invalidateForRealtimeEvent` uses) and invalidates each distinct key
 * EXACTLY ONCE across the whole batch, so two events that happen to target
 * the same cache entry (e.g. two `dashboardKeys.summary()`-touching events in
 * one tick) never cause a duplicate refetch. `truncated: true` (the relay
 * dropped events past the 25-cap) additionally triggers ONE full
 * no-argument `invalidateQueries()` resync - the same "unknown, so refetch
 * everything" idiom the `resync` frame already uses - instead of trusting a
 * partial event list to describe the whole tick.
 */

const HEARTBEAT_COMMENT = 'hb';

/**
 * Handles one parsed `batch` frame body: validates against
 * `batchFrameSchema` (an invalid/malformed batch is dropped exactly like an
 * unparseable single-event frame - never partially trusted), dedupes the
 * query-key set across every named event, invalidates each key once, feeds
 * `onEvent` for every still-known event type (same registry contract as the
 * single-event path), and - if `truncated` - additionally issues ONE full
 * resync invalidation.
 */
function handleBatchFrame(
  queryClient: QueryClient,
  parsed: unknown,
  onEvent?: (event: RealtimeEvent) => void,
): void {
  const result = batchFrameSchema.safeParse(parsed);
  if (!result.success) return;

  const keysToInvalidate = new Map<string, QueryKey>();
  for (const event of result.data.events) {
    for (const queryKey of queryKeysForRealtimeEvent(event)) {
      keysToInvalidate.set(JSON.stringify(queryKey), queryKey);
    }
    if (isKnownRealtimeEventType(event.type)) {
      onEvent?.(event);
    }
  }
  for (const queryKey of keysToInvalidate.values()) {
    void queryClient.invalidateQueries({ queryKey });
  }

  if (result.data.truncated) {
    void queryClient.invalidateQueries();
  }
}

/** Consumes one open response stream until it ends or the connection is aborted. */
export async function consumeStream(
  response: Response,
  queryClient: QueryClient,
  onFrameId: (id: string) => void,
  onEvent?: (event: RealtimeEvent) => void,
): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const parser = createSseFrameParser((frame) => {
    if (frame.id !== undefined) {
      onFrameId(frame.id);
    }
    if (frame.event === HEARTBEAT_COMMENT || frame.event === 'reconnect') return;
    if (frame.event === 'resync') {
      void queryClient.invalidateQueries();
      return;
    }
    if (!frame.data) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      return;
    }

    if (frame.event === 'batch') {
      handleBatchFrame(queryClient, parsed, onEvent);
      return;
    }

    const candidate = parsed as { type?: string };
    if (
      candidate &&
      typeof candidate.type === 'string' &&
      isKnownRealtimeEventType(candidate.type)
    ) {
      const event = parsed as RealtimeEvent;
      invalidateForRealtimeEvent(queryClient, event);
      onEvent?.(event);
    }
  });

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
}
