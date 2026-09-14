import type { Redis } from 'ioredis';
import type { Rng } from '@wp/domain';
import { sysKey } from '../../platform/redis.js';

/**
 * wake.ts (P11 Unit U5, step 8) - the event-driven wake loop. A wake is a
 * HINT, never an authority (phase gotcha, verbatim): Redis pub/sub is
 * at-most-once and has no delivery guarantee across a reconnect, so every
 * eligibility predicate stays inside `db/queries/claim-jobs.sql` - nothing
 * here ever skips a predicate because "the wake told us it is ready".
 *
 * CHANNEL SHAPE: `wp:{env}:wake:c:{clientId}:i:{instanceId}` via
 * `sysKey(env, 'wake', 'c', clientId, 'i', instanceId)` - the existing
 * `platform/redis/keys.ts` builder (never a hand-built template literal;
 * the `eslint:key-construction` guard rejects that). This is deliberately
 * NOT `tenantKey` (which shapes `wp:{env}:c:{clientId}:{parts}`, `c:`
 * BEFORE any other segment) - the task's required literal channel shape
 * puts `wake` first, so `sysKey` with `'c', clientId, 'i', instanceId` as
 * trailing parts is what actually reproduces it.
 *
 * REDIS HANDLE: `redis-ctl` (`platform/redis.ts`'s `createRedis(
 * resolveRedisUrl())`, the SAME handle `modules/realtime/redis-bridge.ts`
 * already uses for its own cross-process pub/sub bridge) - not `redis-sig`
 * (Signal/auth-material tier) or `redis-cache` (rebuildable auth-material
 * tier). A wake is ephemeral control-plane signalling, structurally the
 * same kind of thing the realtime bridge already publishes on `redis-ctl`,
 * not session/auth state.
 *
 * SUBSCRIBER LIFECYCLE mirrors `redis-bridge.ts`'s own subscriber shape
 * exactly (`start()`/`stop()` over a DEDICATED duplicated connection -
 * ioredis requires a separate client once `.subscribe()` is called, since a
 * connection in subscriber mode can no longer issue ordinary commands):
 * `roles/session-worker.ts` calls `start()` when a lease is ACQUIRED (a
 * `RunnerHandle` appears in the registry) and `stop()` when it is RELEASED
 * (the handle disappears) - never a fleet-wide subscription, always
 * per-leased-instance, so one worker's wake traffic never crosses into
 * another worker's claim scope (tenant isolation, core invariant 4).
 *
 * SAFETY POLL: `SAFETY_POLL_BASE_MS = 30_000`, jittered +/- `
 * SAFETY_POLL_JITTER_MS = 12_000` via an INJECTED `Rng` (never
 * `Math.random()` at the call site - `packages/domain`'s own no-wallclock
 * discipline, kept here even though this file is Node-only, for the same
 * determinism-under-test reason). `safetyPollIntervalMs` THROWS (fails
 * closed) rather than clamps when `baseMs` is <= 0 or > 60_000 - a silent
 * clamp would hide a misconfiguration (core invariant 6: no override path,
 * ever, for a correctness mechanism). The poll itself is CORRECTNESS, not
 * an optimisation (pub/sub is at-most-once) - `send-loop.ts` wires this
 * interval directly against `config.SAFETY_POLL_MS` (`platform/config.ts`'s
 * own `.max(60_000)` zod bound is the FIRST fail-closed gate, at process
 * boot; this function's own throw is the second, defence-in-depth gate for
 * any caller that constructs the interval directly, e.g. a test).
 */

export const SAFETY_POLL_BASE_MS = 30_000;
export const SAFETY_POLL_JITTER_MS = 12_000;

/** Builds the tenant-scoped wake channel: `wp:{env}:wake:c:{clientId}:i:{instanceId}`. */
export function wakeChannel(env: string, clientId: string, instanceId: string): string {
  return sysKey(env, 'wake', 'c', clientId, 'i', instanceId);
}

/**
 * Publishes exactly one wake for `(clientId, instanceId)` - callers MUST
 * invoke this only AFTER the enqueue transaction (or resume path) that
 * makes the job/instance eligible has already committed; publishing before
 * commit risks a subscriber waking up to a row it cannot yet see under its
 * own read. `redis.publish` rejecting (e.g. connection down) is swallowed
 * here, not thrown - a dropped wake is exactly the case the mandatory
 * safety poll exists to make survivable (never a caller-visible failure of
 * the enqueue/resume path it rides alongside).
 */
export async function publishWake(
  redis: Pick<Redis, 'publish'>,
  env: string,
  clientId: string,
  instanceId: string,
): Promise<void> {
  const channel = wakeChannel(env, clientId, instanceId);
  try {
    await redis.publish(channel, '1');
  } catch {
    // Fire-and-forget by design (see module doc) - the safety poll is the
    // backstop, not this call's return value.
  }
}

/**
 * Derives one jittered safety-poll interval from `baseMs` (a `[0, 1)` `rng`
 * contract, same as `@wp/domain`'s own `Rng`): `baseMs + (rng.random() * 2
 * - 1) * SAFETY_POLL_JITTER_MS`, i.e. `rng.random() === 0` yields the
 * minimum of the band, `1` the maximum, `0.5` the exact base. THROWS when
 * `baseMs` is not a positive integer <= 60_000 - see module doc for why a
 * throw, never a clamp.
 */
export function safetyPollIntervalMs(baseMs: number, rng: Rng): number {
  if (!Number.isInteger(baseMs) || baseMs <= 0 || baseMs > 60_000) {
    throw new Error(
      `SAFETY_POLL_MS must be a positive integer no greater than 60_000 (60s) - the safety ` +
        `poll is correctness (pub/sub wake is at-most-once), not tuning, and cannot be ` +
        `configured off. Got ${String(baseMs)}.`,
    );
  }
  return baseMs + (rng.random() * 2 - 1) * SAFETY_POLL_JITTER_MS;
}

export interface WakeSubscriberDeps {
  /** A DEDICATED subscriber-mode connection (e.g. `redisCtl.duplicate()`) - never the shared control connection (see module doc). */
  redis: Redis;
  env: string;
  clientId: string;
  instanceId: string;
  /** Invoked once per received wake message on this instance's channel - never awaited by the subscriber itself; the caller (`send-loop.ts`) treats it purely as a hint to wake its own poll/claim loop early. */
  onWake: () => void;
  metrics?: { incrementWakeReceived?: () => void };
}

export interface WakeSubscriber {
  /** Subscribes to this instance's wake channel. Resolves once the SUBSCRIBE command completes. */
  start(): Promise<void>;
  /** Unsubscribes - does NOT close/quit the connection (the caller owns that lifecycle, same convention as `redis-bridge.ts`'s subscriber). */
  stop(): Promise<void>;
}

/**
 * Builds a per-instance wake subscriber. `start()` is the ONLY place a
 * production caller should invoke on LEASE ACQUISITION; `stop()` on lease
 * RELEASE - per-instance, never fleet-wide, so a wake for one tenant's
 * instance can only ever reach a subscriber that was started for that
 * exact `(clientId, instanceId)` pair (tenant isolation by construction: the
 * channel itself is tenant-scoped, and this subscriber only ever listens on
 * ONE channel).
 */
export function createWakeSubscriber(deps: WakeSubscriberDeps): WakeSubscriber {
  const channel = wakeChannel(deps.env, deps.clientId, deps.instanceId);

  function onMessage(receivedChannel: string): void {
    if (receivedChannel !== channel) {
      return;
    }
    deps.metrics?.incrementWakeReceived?.();
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
