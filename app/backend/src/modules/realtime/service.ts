import { realtimeChannel } from '@wp/domain';
import { logger } from '@wp/server-kit';
import type { AuthenticatedContext } from '../../platform/http/route-policy.js';
import type { SseSink } from '../../platform/http/sse.js';
import { TooManyConnectionsError, type RealtimeHub } from './hub.js';

/**
 * modules/realtime/service.ts (P05 Unit U3a) - subscribes one connection to
 * its own client channel plus any requested-and-owned instance channels.
 * `clientId` comes from `req.auth.clientId` ONLY (ADR 0010: "The SSE
 * connection's client_id is locked from the session, never from a query
 * parameter") - a `clientId` query parameter is never read anywhere in this
 * module.
 */

export interface InstanceOwnershipPort {
  isOwnedBy(clientId: string, instanceId: string): Promise<boolean>;
}

/**
 * Production default until P08 ships the real `instances` table - fails
 * CLOSED (core invariant 2: on any unclear state, never proceed as if it
 * were fine). Every requested instance channel is refused, never silently
 * granted, until P08 replaces this port with a real ownership lookup.
 */
export const failClosedInstanceOwnership: InstanceOwnershipPort = {
  async isOwnedBy(): Promise<boolean> {
    return false;
  },
};

// Re-exported so existing importers (routes.ts's error mapping, tests) keep
// working unchanged - the class itself now lives in hub.ts (MAJ-3 fix: the
// hub is the only place that can throw it atomically; see hub.ts's own doc
// comment on `connect`).
export { TooManyConnectionsError };

export interface RealtimeCtx {
  hub: RealtimeHub;
  instanceOwnership: InstanceOwnershipPort;
  maxConnectionsPerUser: number;
  /** Invoked once per refused instance-channel subscription request (U3b/metrics may bind to this later; this unit only counts via the log line). */
  onSubscriptionRefused: () => void;
}

export interface SubscribeConnectionInput {
  auth: AuthenticatedContext;
  requestedInstanceIds: readonly string[];
  lastEventId?: string;
}

export interface SubscribeConnectionResult {
  connectionId: string;
  channels: readonly string[];
}

/**
 * Throws `TooManyConnectionsError` if `auth.userId` is already at the
 * per-user connection cap. Called BEFORE the SSE stream is hijacked
 * (routes.ts) so a refused 6th connection can still get a plain JSON 429
 * response rather than a half-open event-stream.
 */
export function assertUnderConnectionCap(ctx: RealtimeCtx, auth: AuthenticatedContext): void {
  if (ctx.hub.connectionsForUser(auth.userId).length >= ctx.maxConnectionsPerUser) {
    throw new TooManyConnectionsError();
  }
}

/**
 * Subscribes `sink` to the caller's own client channel plus every
 * requested instance channel the caller is proven to own. A refused
 * instance request never fails the connection - it just stays off that one
 * channel, and is counted + logged (`event_type: 'realtime.subscribe_refused'`,
 * allow-listed fields only: `client_id`, `instance_id`). Callers must have
 * already run `assertUnderConnectionCap` before hijacking the stream.
 *
 * MIN-2 fix (frames lost between hijack and full subscription): the
 * connection is registered on `hub.connect` with its OWN client channel
 * FIRST, synchronously, before any `await ctx.instanceOwnership.isOwnedBy(...)`
 * call - a slow (or merely non-instantaneous) ownership lookup used to leave
 * the connection entirely unregistered in the hub for the whole loop above,
 * so any event published to the client's own channel during that window was
 * silently dropped (never queued, never replayed - `hub.publish` only fans
 * out to CURRENTLY subscribed connections). Owned instance channels are
 * added afterwards via `hub.subscribeChannel` as each lookup resolves.
 */
export async function subscribeConnection(
  ctx: RealtimeCtx,
  input: SubscribeConnectionInput,
  sink: SseSink,
  connectionId: string,
): Promise<SubscribeConnectionResult> {
  const { auth } = input;

  const clientChannel = realtimeChannel(auth.clientId);
  const channels: string[] = [clientChannel];

  ctx.hub.connect({
    connectionId,
    userId: auth.userId,
    sessionId: auth.sessionId,
    clientId: auth.clientId,
    epoch: auth.epoch,
    channels,
    sink,
  });

  for (const instanceId of input.requestedInstanceIds) {
    const owned = await ctx.instanceOwnership.isOwnedBy(auth.clientId, instanceId);
    if (owned) {
      const instanceChannel = realtimeChannel(auth.clientId, instanceId);
      channels.push(instanceChannel);
      ctx.hub.subscribeChannel(connectionId, instanceChannel);
      continue;
    }
    ctx.onSubscriptionRefused();
    logger.info(
      {
        client_id: auth.clientId,
        instance_id: instanceId,
        event_type: 'realtime.subscribe_refused',
      },
      'realtime subscription refused: instance not owned by caller',
    );
  }

  return { connectionId, channels };
}
