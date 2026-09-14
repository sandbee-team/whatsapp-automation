import type { RealtimeEvent } from '@wp/contracts';
import type { SseCloseReason, SseSink } from '../../platform/http/sse.js';

/**
 * modules/realtime/hub-types.ts (P05 FIXA, split out of hub.ts for the
 * workspace's 300-line max-lines lint rule) - `RealtimeHub`'s public shape,
 * its input/snapshot/replay types, and `TooManyConnectionsError`. Pure types
 * + one small error class, no behavior - `hub.ts` still owns
 * `createRealtimeHub`'s entire implementation.
 */

export type DropReason = SseCloseReason;

/**
 * Thrown by `RealtimeHub.connect` when `userId` is already at the per-user
 * connection cap. Defined here (not service.ts) so `hub.ts` - the only place
 * that can enforce the cap ATOMICALLY (see `connect`'s doc comment) - never
 * needs to import from `service.ts` (which itself imports hub types,
 * avoiding a cycle). `service.ts` re-exports this same class so existing
 * callers (routes.ts's error mapping) are unaffected.
 */
export class TooManyConnectionsError extends Error {
  readonly code = 'TOO_MANY_CONNECTIONS';
  constructor() {
    super('Too many concurrent real-time connections for this user.');
    this.name = 'TooManyConnectionsError';
  }
}

export interface RealtimeConnectionInput {
  connectionId: string;
  userId: string;
  sessionId: string;
  clientId: string;
  epoch: number;
  channels: readonly string[];
  sink: SseSink;
}

export interface PublishInput {
  clientId: string;
  instanceId?: string;
}

/** Result of `RealtimeHub.replaySince` - either the missed frames, or a signal that the id is unknown/too old. */
export type ReplayResult = { kind: 'frames'; frames: readonly SseFrameLike[] } | { kind: 'resync' };

export interface SseFrameLike {
  id: string;
  event: string;
  data: string;
}

export interface RealtimeHub {
  /** Throws `TooManyConnectionsError` (synchronously, before registering anything) if `input.userId` is already at the per-user cap. */
  connect(input: RealtimeConnectionInput): void;
  /**
   * Adds `channel` to an ALREADY-connected connection's subscription set
   * (MIN-2 fix: `service.ts` registers a connection's own client channel
   * synchronously via `connect`, then adds owned-instance channels here as
   * their `isOwnedBy` lookups resolve - never losing a frame published to
   * the client channel in the gap between hijack and those awaits settling).
   * A no-op (never throws) if `connectionId` no longer exists - the
   * connection may have closed while an ownership lookup was still pending.
   */
  subscribeChannel(connectionId: string, channel: string): void;
  disconnect(connectionId: string, reason: DropReason): void;
  /** Validates via `realtimeEventSchema` AND `assertIdsOnly` before fan-out - throws and sends nothing on a non-conforming event. */
  publish(event: RealtimeEvent & PublishInput): void;
  connectionsForUser(userId: string): readonly string[];
  distinctUserIds(): readonly string[];
  connectionCount(): number;
  dropWhere(predicate: (conn: RealtimeConnectionSnapshot) => boolean, reason: DropReason): number;
  closeAll(reason: DropReason): void;
  onDrop(cb: (reason: DropReason) => void): void;
  onConnectionCountChange(cb: (count: number) => void): void;
  /**
   * Resume support for `Last-Event-ID`: `lastEventId` known in `channel`'s
   * replay ring -> the frames strictly after it; unknown/too old (including
   * "no ring exists yet for this channel") -> `{ kind: 'resync' }`, telling
   * the caller to send one `event: resync` frame.
   */
  replaySince(channel: string, lastEventId: string): ReplayResult;
}

/** Read-only snapshot of a connection's identity - the shape `dropWhere`'s predicate (U3b's authz tick) sees. */
export interface RealtimeConnectionSnapshot {
  connectionId: string;
  userId: string;
  sessionId: string;
  clientId: string;
  epoch: number;
  channels: readonly string[];
}

export interface CreateRealtimeHubOptions {
  replayRingSize: number;
  /**
   * Per-user connection cap, enforced ATOMICALLY inside `connect` (MAJ-3
   * fix - a check performed by the caller BEFORE `connect`, with any awaited
   * work in between, is a check-then-act race that N concurrent requests can
   * all pass). Defaults to unlimited so existing tests that never pass this
   * option are unaffected; production wiring (roles/api.ts) always sets it
   * from `SSE_MAX_CONNECTIONS_PER_USER`.
   */
  maxConnectionsPerUser?: number;
}
