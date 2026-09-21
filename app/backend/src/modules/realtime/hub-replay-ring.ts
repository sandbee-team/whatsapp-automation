import type { ReplayResult, SseFrameLike } from './hub-types.js';

/**
 * hub-replay-ring.ts (2026-09-17 "first QR always lost" fix) - the replay
 * ring's storage + both its read paths, split out of `hub.ts` for the
 * workspace's 300-line max-lines rule (`hub.ts` was already at exactly 300
 * lines - same sibling-module split idiom `resume.routes.ts`/
 * `delete.routes.ts` established in `modules/instances/**`: pure code
 * motion, re-exported from the original call site, doc comment explaining
 * why it moved).
 *
 * ROOT CAUSE this file fixes ("first time 5 scans left me kuch nahi aata"):
 * the ring buffer this module owns has ALWAYS existed and has ALWAYS been
 * populated on every `publish` (`hub.ts`'s `pushToRing` call runs before the
 * subscriber-count check, so a publish-with-zero-subscribers still lands in
 * the ring - proven by `hub-replay.test.ts`'s own
 * `publish_with_zero_subscribers_still_records_the_frame...` case). The gap
 * was that NOTHING ever drained it for a first-time subscriber: `replaySince`
 * (this file's `replaySince`) is only ever invoked from `routes.ts` when the
 * incoming request carries a `Last-Event-ID` header, and a browser opening
 * the Connect sheet for the very first time has never received a frame yet,
 * so it has no id to send - `routes.ts`'s `if (lastEventId !== undefined)`
 * guard (routes.ts:110) skips replay entirely for that connection. Baileys
 * fires its first `qr` almost immediately after the socket opens
 * (provider/baileys/socket-factory.ts's `qrTimeout: 45_000` is its OWN
 * refresh cadence, not a delay before the first QR) - almost always sooner
 * than the browser's SECOND, instance-scoped SSE connection
 * (`sse-instance-stream.ts`) finishes its fetch handshake and reaches
 * `hub.subscribeChannel` (service.ts's `subscribeConnection`). That publish
 * lands in the ring (this file) but was never replayed to the connection
 * that arrives moments later - dropped for good until Baileys' next
 * refresh, ~45s on.
 *
 * FIX: `replayUndeliveredOnSubscribe` runs unconditionally from
 * `hub.subscribeChannel` (hub.ts) every time a channel is ADDED to an
 * already-connected connection - no `Last-Event-ID` required, because a
 * connection reaching this path for the first time has never had the chance
 * to receive one. This is deliberately NOT wired into `connect`'s initial
 * channel list (the client-wide channel) - only `subscribeChannel`, the
 * exact seam `service.ts#subscribeConnection` uses to add an
 * ownership-checked instance channel (MIN-2 fix's own two-phase shape) -
 * scoping the behavior change to precisely the path this incident lives on,
 * never widening it to "every channel replays its whole ring on every
 * connect" (which would re-deliver stale non-QR events, e.g. an old
 * `notification.created`, on every ordinary reconnect of the client-wide
 * stream).
 *
 * EXPIRY SAFETY (per this fix's own review note - "a QR is a credential"):
 * `instance.qr` is the only event type in `REALTIME_EVENT_TYPES` that
 * carries a caller-meaningful `expiresAt` today, but this filter is written
 * generically against "does the parsed frame have a string `expiresAt`
 * field", not hardcoded to `instance.qr`'s shape - a replayed frame whose
 * `expiresAt` has already passed is dropped from replay, never sent. This
 * mirrors `QrPanel.tsx`'s own `isExpired` computation (`expiresAt` vs `now()`)
 * so a stale-replayed QR cannot render as if it were still live; the panel
 * would otherwise show a countdown ring for a QR WhatsApp itself already
 * rejected. A frame with no `expiresAt` field (e.g. `instance.
 * pacing_changed`) is never filtered by this check - only events that
 * declare their own expiry are subject to it.
 */

interface RingEntry {
  id: string;
  event: string;
  data: string;
}

/** Bounded per-channel replay ring - `channel name -> last `replayRingSize` frames`. */
export type ReplayRings = Map<string, RingEntry[]>;

export function createReplayRings(): ReplayRings {
  return new Map();
}

export function pushToRing(rings: ReplayRings, replayRingSize: number, channel: string, entry: RingEntry): void {
  let ring = rings.get(channel);
  if (!ring) {
    ring = [];
    rings.set(channel, ring);
  }
  ring.push(entry);
  if (ring.length > replayRingSize) {
    ring.shift();
  }
}

/** Resume support for `Last-Event-ID` - see `RealtimeHub.replaySince`'s own doc comment (hub-types.ts) for the exact contract. */
export function replaySince(rings: ReplayRings, channel: string, lastEventId: string): ReplayResult {
  const ring = rings.get(channel);
  if (!ring) {
    return { kind: 'resync' };
  }
  const index = ring.findIndex((entry) => entry.id === lastEventId);
  if (index === -1) {
    return { kind: 'resync' };
  }
  return { kind: 'frames', frames: ring.slice(index + 1) };
}

/**
 * Extracts `data.expiresAt` from a ring entry's already-serialized JSON
 * payload, if present and a string - returns `undefined` for anything else
 * (no `expiresAt` field, malformed JSON, non-string value), which the caller
 * treats as "never expires" rather than throwing. Ring entries are always
 * built from `realtimeEventSchema.parse`d output (hub.ts's `publish`), so a
 * parse failure here would mean the hub's own serialization is broken, not
 * that untrusted data reached this function - fail-safe (skip the filter),
 * not fail-open (send stale unconditionally) or a crash, is the correct
 * response to a shape this function does not recognize.
 */
function expiresAtOf(entry: RingEntry): string | undefined {
  try {
    const parsed: unknown = JSON.parse(entry.data);
    if (parsed && typeof parsed === 'object' && 'expiresAt' in parsed) {
      const value = (parsed as { expiresAt?: unknown }).expiresAt;
      return typeof value === 'string' ? value : undefined;
    }
  } catch {
    // Malformed JSON never reaches here in practice (see doc comment) -
    // fail-safe: treat as "no expiry", same as a frame with no such field.
  }
  return undefined;
}

/**
 * Replays every NOT-YET-EXPIRED frame currently in `channel`'s ring to one
 * sink - the fix for the first-QR-lost race (see module doc comment). Unlike
 * `replaySince`, this takes no starting id: it is invoked for a connection
 * that has never received a frame on this channel before, so there is no
 * "since" to resume from - the whole (bounded, `replayRingSize`-capped) ring
 * is the candidate set, filtered down to what is still valid `now`.
 */
export function replayUndeliveredOnSubscribe(
  rings: ReplayRings,
  channel: string,
  write: (frame: SseFrameLike) => void,
  now: () => number,
): void {
  const ring = rings.get(channel);
  if (!ring) return;
  const nowMs = now();
  for (const entry of ring) {
    const expiresAt = expiresAtOf(entry);
    if (expiresAt !== undefined && new Date(expiresAt).getTime() <= nowMs) {
      continue;
    }
    write({ id: entry.id, event: entry.event, data: entry.data });
  }
}
