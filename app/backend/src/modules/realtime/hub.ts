import { randomUUID } from 'node:crypto';
import { realtimeEventSchema } from '@wp/contracts';
import { assertIdsOnly, REALTIME_PAYLOAD_KEYS, type RealtimePayloadEventType } from '@wp/domain';
import type { SseSink } from '../../platform/http/sse.js';
import {
  TooManyConnectionsError,
  type CreateRealtimeHubOptions,
  type DropReason,
  type RealtimeConnectionSnapshot,
  type RealtimeHub,
} from './hub-types.js';

/**
 * modules/realtime/hub.ts (P05 Unit U3a) - the in-process real-time fan-out
 * hub. ADR 0010: "Correctness never depends on NOTIFY" - this hub is a pure
 * in-process `publish` port with one in-process implementation (this file);
 * there is no Postgres LISTEN connection here and no outbox yet (P15 wires
 * the real relay). A future multi-process fan-out replaces/wraps this with
 * Redis pub/sub behind the SAME `publish` shape - nothing above this module
 * needs to change when that happens.
 *
 * U3b seam: `dropWhere`, `onDrop`, `onConnectionCountChange` and
 * `onPublishNoSubscribers` are hooks for the periodic authz re-check tick
 * and for metrics wiring (`metrics.ts` binds all four) - callers bind to
 * these, they do not modify this file's connect/publish/disconnect logic.
 *
 * Public types live in `hub-types.ts` (split out for the workspace's
 * 300-line max-lines rule) - re-exported below so existing importers are
 * unaffected.
 */

export {
  TooManyConnectionsError,
  type CreateRealtimeHubOptions,
  type DropReason,
  type PublishInput,
  type RealtimeConnectionInput,
  type RealtimeConnectionSnapshot,
  type RealtimeHub,
  type ReplayResult,
  type SseFrameLike,
} from './hub-types.js';

interface Connection {
  connectionId: string;
  userId: string;
  sessionId: string;
  clientId: string;
  epoch: number;
  channels: Set<string>;
  sink: SseSink;
}

interface RingEntry {
  id: string;
  event: string;
  data: string;
}

function snapshotOf(conn: Connection): RealtimeConnectionSnapshot {
  return {
    connectionId: conn.connectionId,
    userId: conn.userId,
    sessionId: conn.sessionId,
    clientId: conn.clientId,
    epoch: conn.epoch,
    channels: [...conn.channels],
  };
}

export function createRealtimeHub(options: CreateRealtimeHubOptions): RealtimeHub {
  const bootNonce = randomUUID();
  let seq = 0;

  const connections = new Map<string, Connection>();
  /** channel name -> set of connectionIds subscribed to it. */
  const channelIndex = new Map<string, Set<string>>();
  /** channel name -> bounded replay ring of the last `replayRingSize` frames. */
  const replayRings = new Map<string, RingEntry[]>();

  const dropCallbacks: Array<(reason: DropReason) => void> = [];
  const connectionCountCallbacks: Array<(count: number) => void> = [];
  const publishNoSubscribersCallbacks: Array<() => void> = [];

  function notifyConnectionCountChange(): void {
    const count = connections.size;
    for (const cb of connectionCountCallbacks) {
      cb(count);
    }
  }

  function nextFrameId(): string {
    seq += 1;
    return `${bootNonce}-${seq}`;
  }

  function indexChannel(channel: string, connectionId: string): void {
    let set = channelIndex.get(channel);
    if (!set) {
      set = new Set();
      channelIndex.set(channel, set);
    }
    set.add(connectionId);
  }

  function unindexConnection(conn: Connection): void {
    for (const channel of conn.channels) {
      const set = channelIndex.get(channel);
      if (!set) continue;
      set.delete(conn.connectionId);
      if (set.size === 0) {
        channelIndex.delete(channel);
      }
    }
  }

  function pushToRing(channel: string, entry: RingEntry): void {
    let ring = replayRings.get(channel);
    if (!ring) {
      ring = [];
      replayRings.set(channel, ring);
    }
    ring.push(entry);
    if (ring.length > options.replayRingSize) {
      ring.shift();
    }
  }

  const maxConnectionsPerUser = options.maxConnectionsPerUser ?? Infinity;

  return {
    connect(input) {
      // MAJ-3 fix: the per-user cap MUST be checked-and-registered in the
      // same synchronous turn as the count read - this is the only call in
      // the whole request path with no `await` between reading the count and
      // mutating `connections`, so it is the only place the cap can be
      // enforced atomically. `routes.ts`'s pre-hijack `assertUnderConnectionCap`
      // call remains as a fast-path optimisation only (avoids hijacking a
      // stream that's obviously already over cap) - this check here is the
      // authority.
      if (maxConnectionsPerUser !== Infinity) {
        let countForUser = 0;
        for (const existing of connections.values()) {
          if (existing.userId === input.userId) countForUser += 1;
        }
        if (countForUser >= maxConnectionsPerUser) {
          throw new TooManyConnectionsError();
        }
      }

      const conn: Connection = {
        connectionId: input.connectionId,
        userId: input.userId,
        sessionId: input.sessionId,
        clientId: input.clientId,
        epoch: input.epoch,
        channels: new Set(input.channels),
        sink: input.sink,
      };
      connections.set(conn.connectionId, conn);
      for (const channel of conn.channels) {
        indexChannel(channel, conn.connectionId);
      }

      conn.sink.onClose((reason) => {
        // The sink can close on its own (client disconnect, slow consumer
        // detected by sse.ts's own bounded queue) without a caller ever
        // invoking `disconnect` - keep the hub's bookkeeping in sync either
        // way, but only run the drop side-effects once.
        if (!connections.has(conn.connectionId)) return;
        connections.delete(conn.connectionId);
        unindexConnection(conn);
        for (const cb of dropCallbacks) {
          cb(reason);
        }
        notifyConnectionCountChange();
      });

      notifyConnectionCountChange();
    },

    subscribeChannel(connectionId, channel) {
      const conn = connections.get(connectionId);
      if (!conn) return;
      if (conn.channels.has(channel)) return;
      conn.channels.add(channel);
      indexChannel(channel, conn.connectionId);
    },

    disconnect(connectionId, reason) {
      const conn = connections.get(connectionId);
      if (!conn) return;
      conn.sink.close(reason);
      // `sink.close` -> `onClose` above handles bookkeeping + the onDrop callback.
    },

    publish(event) {
      // `clientId` is routing metadata (which channel this fans out to) -
      // it is never part of the validated event payload itself (the
      // discriminated union's schemas are `.strict()` and do not declare
      // it). `instanceId` IS part of several events' own payload schema
      // (instance.pacing_changed, message.job.status_changed, ...), so it
      // must stay when the event itself declares it, and is only used for
      // routing when the event's own schema has no such field (e.g.
      // campaign.progress has no instanceId).
      const eventOnly: Record<string, unknown> = { ...event };
      delete eventOnly.clientId;
      const parsed = realtimeEventSchema.parse(eventOnly);
      const allowedKeys = REALTIME_PAYLOAD_KEYS[parsed.type as RealtimePayloadEventType];
      const payloadOnly: Record<string, unknown> = { ...parsed };
      delete payloadOnly.type;
      assertIdsOnly(payloadOnly, allowedKeys, parsed.type);

      const channel =
        event.instanceId !== undefined
          ? `client:${event.clientId}:instance:${event.instanceId}`
          : `client:${event.clientId}`;

      const frameId = nextFrameId();
      const data = JSON.stringify(parsed);
      pushToRing(channel, { id: frameId, event: parsed.type, data });

      // FIX (2026-09-15/16 live incident): `instance.qr` always routed here
      // to the instance channel, but the browser subscribed client-wide only
      // - worker publish + bridge subscriber both worked (zero warnings),
      // this branch just returned, silently. Fixed at the call site
      // (`sse-instance-stream.ts`); `onPublishNoSubscribers` (a counter, not
      // per-event logging - `metrics.ts`) makes a future mismatch visible.
      const subscribers = channelIndex.get(channel);
      if (!subscribers) {
        for (const cb of publishNoSubscribersCallbacks) {
          cb();
        }
        return;
      }
      for (const connectionId of subscribers) {
        const conn = connections.get(connectionId);
        if (!conn) continue;
        conn.sink.write({ id: frameId, event: parsed.type, data });
      }
    },

    connectionsForUser(userId) {
      const ids: string[] = [];
      for (const conn of connections.values()) {
        if (conn.userId === userId) ids.push(conn.connectionId);
      }
      return ids;
    },

    distinctUserIds() {
      return [...new Set([...connections.values()].map((c) => c.userId))];
    },

    connectionCount() {
      return connections.size;
    },

    dropWhere(predicate, reason) {
      let dropped = 0;
      for (const conn of [...connections.values()]) {
        if (predicate(snapshotOf(conn))) {
          conn.sink.close(reason);
          dropped += 1;
        }
      }
      return dropped;
    },

    closeAll(reason) {
      for (const conn of [...connections.values()]) {
        conn.sink.close(reason);
      }
    },

    onDrop(cb) {
      dropCallbacks.push(cb);
    },

    onConnectionCountChange(cb) {
      connectionCountCallbacks.push(cb);
    },

    onPublishNoSubscribers(cb) {
      publishNoSubscribersCallbacks.push(cb);
    },

    replaySince(channel, lastEventId) {
      const ring = replayRings.get(channel);
      if (!ring) {
        return { kind: 'resync' };
      }
      const index = ring.findIndex((entry) => entry.id === lastEventId);
      if (index === -1) {
        return { kind: 'resync' };
      }
      return { kind: 'frames', frames: ring.slice(index + 1) };
    },
  };
}
