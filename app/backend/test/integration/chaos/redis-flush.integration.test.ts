import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSyntheticFleetHandles,
  disposeSyntheticFleetHandles,
  type SyntheticFleetHandles,
} from '../../../src/engine/session/synthetic-fleet-support.js';
import { createRedis, resolveSigRedisUrl } from '../../../src/platform/redis.js';
import {
  assertFlushTargetAllowed,
  ForbiddenFlushTargetError,
} from '../../../../../scripts/chaos/run-chaos.js';
import {
  CHAOS_FLEET_PLAN,
  startChaosFleet,
  waitUntilOutcome,
  dbSize,
} from './chaos-fleet-workload.js';
import { readFence } from '../../../src/engine/measure/run-chaos-fleet-reads.js';
import type { ScaleFleet } from '../../../src/engine/measure/scale-fleet.js';

/**
 * redis-flush.integration.test.ts (P26 U6b, step 6 chaos: redis-flush) - the
 * `FLUSHALL redis-ctl` chaos drill at fleet scale (unit-scale precedent:
 * `engine/lease/redis-flush.integration.test.ts`'s
 * `redis_flush_does_not_deadlock_claims`), re-run against the real
 * multi-PROCESS `ScaleFleet` harness. Same fleet shape as
 * `worker-kill.integration.test.ts` (`chaos-fleet-workload.ts`'s
 * `CHAOS_FLEET_PLAN`/`startChaosFleet`).
 *
 * FENCE-REGRESSION OBSERVABILITY (deviation, documented per the task's own
 * escape hatch): `wp_fence_regression_total` lives inside EACH CHILD
 * PROCESS's own in-memory `MetricsRegistry` (`bindLeaseMetrics` is called
 * once per `createSessionWorker` composition, inside `scale-fleet-child.ts`
 * - see that file's own header) - there is no cross-process metrics
 * aggregation channel in this harness (`ChildMessage`'s `stats` shape does
 * not carry it), so a real read of that counter is structurally
 * unobservable from this parent test process. What IS observable from the
 * parent is the invariant the metric is a canary FOR: `instance_lease_state.
 * current_fence` never regresses (strictly monotonic per instance, read
 * directly from Postgres, the source of truth) - asserted directly below
 * instead of a fabricated counter read.
 *
 * REDIS-SIG ISOLATION OBSERVABILITY (second deviation): `SyntheticFleetHandles`
 * (`synthetic-fleet-support.ts#createSyntheticFleetHandles`) and
 * `scale-fleet-child.ts` both build every one of their `redisCtl`/`redisSig`/
 * `redisCache` connections via the SAME `resolveRedisUrl()` (never
 * `resolveSigRedisUrl()`), so inside THIS harness `handles.redisSig` is the
 * identical physical Redis server as `handles.redisCtl` - a `dbsize` diff
 * across a `flushall()` on one would trivially "fail" the isolation proof
 * for a reason that has nothing to do with this test's own drill logic. The
 * genuinely separate `redis-sig` tier this drill must never touch is the
 * real infra-level server at `resolveSigRedisUrl()` (a distinct port/
 * container in dev, `wp-dev-redis-sig-1`) - this file opens its OWN direct
 * probe connection to that real server (`sigProbe`, never routed through
 * the fleet's own handles) and asserts ITS key count is unchanged, which is
 * the true, sound proof that the drill's `flushall()` call never reached
 * that server.
 */

const N_INSTANCES = CHAOS_FLEET_PLAN.workers * CHAOS_FLEET_PLAN.instancesPerWorker;
/** `wake.ts`'s own `SAFETY_POLL_BASE_MS` - "one scan interval" for the claiming-resumes-within bound. */
const SAFETY_POLL_BASE_MS = 30_000;

let handles: SyntheticFleetHandles;
let fleet: ScaleFleet;
/** A direct probe connection to the REAL redis-sig server (`resolveSigRedisUrl()`) - never routed through the fleet's own handles. See this file's own header (REDIS-SIG ISOLATION OBSERVABILITY) for why. */
let sigProbe: ReturnType<typeof createRedis>;

beforeAll(async () => {
  handles = createSyntheticFleetHandles();
  fleet = await startChaosFleet(handles);
  sigProbe = createRedis(resolveSigRedisUrl());
}, 60_000);

afterAll(async () => {
  await fleet.stop();
  await disposeSyntheticFleetHandles(handles);
  sigProbe.disconnect();
}, 30_000);

describe('redis-flush chaos drill (fleet scale, P26 U6b)', () => {
  it('redis_flush_does_not_deadlock_claims', async () => {
    const owners = await fleet.ownerMap();
    expect(owners.size).toBe(N_INSTANCES);

    const fenceBefore = new Map<string, bigint>();
    for (const instanceId of owners.keys()) {
      const fence = await readFence(handles.pool, instanceId, fleet.clientIds());
      if (fence !== undefined) fenceBefore.set(instanceId, fence);
    }

    // FLUSHALL the redis-ctl connection ONLY - never handles.redisSig.
    await handles.redisCtl.flushall();

    // Claiming resumes within ONE scan interval: bounded wait on the
    // OUTCOME (every instance still owned, by SOME live worker, once the
    // fleet has had a chance to re-acquire past the flush) - never a
    // timing-margin assertion.
    const resumed = await waitUntilOutcome(async () => {
      const after = await fleet.ownerMap();
      if (after.size !== N_INSTANCES) return false;
      return [...after.values()].every(
        (owner) =>
          owner === 'scale-worker-0' || owner === 'scale-worker-1' || owner === 'scale-worker-2',
      );
    }, SAFETY_POLL_BASE_MS + 15_000);
    expect(resumed).toBe(true);

    // Fence never regresses across the whole exercise (the observable
    // invariant `wp_fence_regression_total` canaries for - see this file's
    // own header deviation note for why the counter itself is unobservable
    // here).
    for (const instanceId of owners.keys()) {
      const fenceAfter = await readFence(handles.pool, instanceId, fleet.clientIds());
      const before = fenceBefore.get(instanceId);
      expect(fenceAfter).toBeDefined();
      expect(before).toBeDefined();
      expect(fenceAfter! >= before!).toBe(true);
    }
  }, 60_000);

  it('the_flush_target_is_redis_ctl_and_never_redis_sig', async () => {
    expect(() => assertFlushTargetAllowed('redis-sig')).toThrow(ForbiddenFlushTargetError);
    try {
      assertFlushTargetAllowed('redis-sig');
      expect.unreachable('assertFlushTargetAllowed should have thrown for redis-sig');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenFlushTargetError);
      expect((err as Error).message).toContain('redis-sig');
      expect((err as Error).message).toContain('0018');
    }
    expect(() => assertFlushTargetAllowed('redis-ctl')).not.toThrow();

    // Proof the drill did not touch the ratchet store: the REAL redis-sig
    // server's key count is unchanged across a flush of handles.redisCtl
    // only (see this file's own header, REDIS-SIG ISOLATION OBSERVABILITY,
    // for why `sigProbe` - not `handles.redisSig` - is the sound probe).
    const sigCountBefore = await dbSize(sigProbe);
    await handles.redisCtl.flushall();
    const sigCountAfter = await dbSize(sigProbe);
    expect(sigCountAfter).toBe(sigCountBefore);
  }, 30_000);

  it('sessions_stay_open_across_a_control_plane_flush', async () => {
    const ownersBefore = await fleet.ownerMap();
    const fenceBefore = new Map<string, bigint>();
    for (const instanceId of ownersBefore.keys()) {
      const fence = await readFence(handles.pool, instanceId, fleet.clientIds());
      if (fence !== undefined) fenceBefore.set(instanceId, fence);
    }

    await handles.redisCtl.flushall();

    // Every instance is still owned after the flush (fence advances by at
    // most one takeover cycle - never more than a single re-acquire, and
    // never orphaned).
    const settled = await waitUntilOutcome(async () => {
      const after = await fleet.ownerMap();
      return after.size === N_INSTANCES;
    }, SAFETY_POLL_BASE_MS + 15_000);
    expect(settled).toBe(true);

    const ownersAfter = await fleet.ownerMap();
    expect(ownersAfter.size).toBe(N_INSTANCES);
    for (const [instanceId] of ownersBefore) {
      expect(ownersAfter.has(instanceId)).toBe(true);
    }

    // No child process died: stats()/requestStats() still answers for all
    // three workers.
    const stats = await fleet.requestStats();
    expect(stats.size).toBe(CHAOS_FLEET_PLAN.workers);
    for (const workerId of ['scale-worker-0', 'scale-worker-1', 'scale-worker-2']) {
      expect(stats.has(workerId)).toBe(true);
    }
  }, 60_000);
});
