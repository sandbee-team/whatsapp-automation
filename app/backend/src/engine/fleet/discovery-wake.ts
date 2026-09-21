import type { Redis } from 'ioredis';
import { sysKey } from '../../platform/redis.js';

/**
 * discovery-wake.ts (2026-09-17, "QR takes 3-12s to appear" fix) - a
 * fleet-wide wake for the discovery scan loop, following the EXACT
 * established shape `engine/queue/wake.ts` already uses for the per-instance
 * send-loop wake: pub/sub as a LATENCY OPTIMISATION ONLY, never an authority.
 * The existing `roles/session-worker.ts` scan timer (5000ms +/- 2000ms
 * jitter, `SCAN_INTERVAL_BASE_MS`/`SCAN_INTERVAL_JITTER_MS`) is left running
 * UNCONDITIONALLY - this wake never replaces it, only shortens the average
 * wait for the common case.
 *
 * WHY A SEPARATE, FLEET-WIDE CHANNEL (not a reuse of `wake.ts`'s per-instance
 * `wake:c:{clientId}:i:{instanceId}` channel): that channel is subscribed to
 * by exactly ONE worker process - whichever one currently holds the lease
 * for that instance (`createWakeSubscriber`'s `start()`/`stop()` run on
 * lease ACQUIRE/RELEASE, `send-loop-worker-wiring.ts`). A freshly-created
 * pairing intent (`POST /v1/instances/:id/link` -> `beginPairingIntent`,
 * `db/queries/instance-begin-pairing.sql`) has NO lease yet - by definition,
 * nobody holds it, that is exactly what makes it eligible for
 * `discover-instances.sql`'s unowned scan (`engine/fleet/discovery.ts`).
 * ANY worker process's discovery cycle could be the one that grabs it next,
 * so the wake must reach EVERY worker, not the one (nonexistent) subscriber
 * a per-instance channel would reach. This channel therefore has no
 * `clientId`/`instanceId` segment - `sysKey(env, 'discovery', 'wake')` is
 * fleet-wide by design, and every `roles/session-worker.ts` process
 * subscribes to it ONCE at boot (not per-lease, since discovery itself runs
 * fleet-wide, before any lease exists) and never unsubscribes until
 * shutdown - mirroring `modules/realtime/redis-bridge.ts`'s own always-on
 * subscriber lifecycle, not `wake.ts`'s per-lease one.
 *
 * SAFETY: this is fire-and-forget exactly like `wake.ts#publishWake` (a
 * publish failure is swallowed, never surfaced as a `/link` request
 * failure) and the receiving side treats a wake purely as "run the next scan
 * cycle now instead of waiting out the rest of the jittered interval" -
 * every eligibility predicate still lives in `discover-instances.sql`
 * (`wp_session_bootstrap_scan`), never short-circuited here. A dropped wake
 * (Redis down, no active subscribers this instant) is exactly the case the
 * unconditional 5s+/-2s poll already survives - this fix changes best-case
 * latency, never the correctness floor.
 */

const DISCOVERY_WAKE_CHANNEL_SUFFIX = ['discovery', 'wake'] as const;

/** Builds the fleet-wide discovery wake channel: `wp:{env}:discovery:wake`. */
export function discoveryWakeChannel(env: string): string {
  return sysKey(env, ...DISCOVERY_WAKE_CHANNEL_SUFFIX);
}

/**
 * Publishes one fleet-wide discovery wake. Callers MUST invoke this only
 * AFTER the transaction that made an instance newly eligible for discovery
 * has already committed (same ordering rule as `wake.ts#publishWake`) - the
 * one production caller today is `POST /v1/instances/:id/link`, right after
 * `beginPairingIntent`'s UPDATE commits (`instances.routes.ts`). A publish
 * failure (e.g. Redis momentarily down) is swallowed, never thrown - the
 * mandatory scan-interval poll is what makes a dropped wake survivable, not
 * this call's return value.
 */
export async function publishDiscoveryWake(
  redis: Pick<Redis, 'publish'>,
  env: string,
): Promise<void> {
  try {
    await redis.publish(discoveryWakeChannel(env), '1');
  } catch {
    // Fire-and-forget by design (see module doc) - the scan-interval poll is
    // the backstop, not this call's return value.
  }
}

export interface DiscoveryWakeSubscriberDeps {
  /** A DEDICATED subscriber-mode connection (e.g. `redisCtl.duplicate()`) - never the shared control connection, same reasoning as `wake.ts`'s own subscriber. */
  redis: Redis;
  env: string;
  /** Invoked once per received wake - never awaited by the subscriber itself; the caller (`roles/session-worker.ts`) treats it purely as a hint to run the next scan cycle immediately instead of waiting out the rest of the current jittered interval. */
  onWake: () => void;
  metrics?: { incrementDiscoveryWakeReceived?: () => void };
}

export interface DiscoveryWakeSubscriber {
  /** Subscribes to the fleet-wide discovery wake channel. Resolves once the SUBSCRIBE command completes. */
  start(): Promise<void>;
  /** Unsubscribes - does NOT close/quit the connection (the caller owns that lifecycle), same convention as `wake.ts#createWakeSubscriber`. */
  stop(): Promise<void>;
}

/**
 * Builds the fleet-wide discovery wake subscriber. Unlike
 * `wake.ts#createWakeSubscriber` (per-instance, started on lease acquire),
 * `start()` here is called ONCE per worker process at boot (before the scan
 * timer's first `scheduleNext()`) and `stop()` once at shutdown - this
 * subscriber's whole lifetime is the process's lifetime, never a per-lease
 * window, because discovery itself runs fleet-wide with no lease of its own.
 */
export function createDiscoveryWakeSubscriber(
  deps: DiscoveryWakeSubscriberDeps,
): DiscoveryWakeSubscriber {
  const channel = discoveryWakeChannel(deps.env);

  function onMessage(receivedChannel: string): void {
    if (receivedChannel !== channel) {
      return;
    }
    deps.metrics?.incrementDiscoveryWakeReceived?.();
    deps.onWake();
  }

  return {
    async start(): Promise<void> {
      deps.redis.on('message', onMessage);
      await deps.redis.subscribe(channel);
    },
    async stop(): Promise<void> {
      deps.redis.off('message', onMessage);
      await deps.redis.unsubscribe(channel);
    },
  };
}
