import { describe, expect, it, vi } from 'vitest';
import type { WorkerDb } from '@wp/db';
import { TIMING } from '@wp/domain';
import { LeaseHeartbeat } from './heartbeat.js';
import type { LeaseRedis } from './lease-redis.js';
import type { LeaseQueryable } from './lease-state-repo.js';
import {
  COMPRESSED_TIMING,
  stubWorkerDb,
  makeLease,
  makeSessionOwner,
} from './heartbeat-c2-test-support.js';

/**
 * heartbeat.c2-slow-redis.test.ts (P06 C2 all-cases pass, FIX-P09-B split) -
 * probe 4, split out of `heartbeat.c2.test.ts` at FIX-P09-B for the
 * max-lines cap (topic split only - same case, unchanged). Not covered by
 * heartbeat.edge.test.ts / heartbeat.integration.test.ts / watchdog.test.ts:
 *
 *   4. Slow-not-down Redis just under `redisCommandTimeoutMs`: renew
 *      resolves at timeoutMs - epsilon -> treated as a real success (no
 *      timeout rejection, watchdog baseline resets, no fence loss).
 *
 * No real Redis/Postgres, no real timers - Redis/PG calls are manually
 * controlled deferred promises; `monotonicNow` is a fully injected counter.
 */

describe('probe 4: slow-not-down Redis just under redisCommandTimeoutMs', () => {
  it('a_redis_renew_that_resolves_successfully_just_before_the_timeout_boundary_is_treated_as_a_real_success_watchdog_resets', async () => {
    // lease-redis.ts's own timeout wrapper is not exercised here (that is a
    // real-Redis integration concern) - this probes heartbeat.ts's OWN
    // handling of a renewBatch call that takes a long time but still
    // resolves successfully (not reject) with a per-instance `true` - i.e.
    // "slow but alive", the opposite of "hung/unreachable". The watchdog
    // baseline must reset exactly as it would for a fast renewal.
    const lease = makeLease('inst-slow-redis');
    const sessionOwner = makeSessionOwner();

    let resolveRedis: ((value: boolean[]) => void) | undefined;
    const redisRenewBatch = vi.fn(
      () =>
        new Promise<boolean[]>((resolve) => {
          resolveRedis = resolve;
        }),
    );
    const leaseRedis: LeaseRedis = {
      acquire: vi.fn(),
      setFence: vi.fn(),
      renewBatch: redisRenewBatch as unknown as LeaseRedis['renewBatch'],
      release: vi.fn(),
    };

    const pgQuery = vi.fn().mockResolvedValue({ rows: [{ instance_id: 'inst-slow-redis' }] });
    const pgSql: WorkerDb = stubWorkerDb({ query: pgQuery as unknown as LeaseQueryable['query'] });

    let monotonicNs = 0n;
    const heartbeat = new LeaseHeartbeat({
      leaseRedis,
      pgSql,
      sessionOwner,
      workerId: 'worker-1',
      env: 'test',
      timing: COMPRESSED_TIMING as unknown as typeof TIMING,
      monotonicNow: () => monotonicNs,
    });
    heartbeat.add(lease);

    // Advance monotonic time to just under redisCommandTimeoutMs (2_000ms)
    // BEFORE the Redis call resolves - simulating "slow, not down": the
    // call is still in flight, near the timeout boundary, but WILL resolve
    // successfully rather than reject/hang forever.
    monotonicNs = 1_999_000_000n; // 1_999ms in ns - 1ms under the 2_000ms timeout

    const tickPromise = heartbeat.tick();
    // Resolve the slow-but-alive Redis call with an explicit success.
    resolveRedis?.([true]);
    await tickPromise;

    expect(sessionOwner.onFenceLost).not.toHaveBeenCalled();

    // Prove the watchdog baseline actually reset to the "slow resolve" time
    // (1_999ms), not the tick-start time (0ms): advancing to
    // 1_999ms + watchdogMs(15_000ms) - 1ms must NOT fire; crossing it must.
    monotonicNs = 1_999_000_000n + 15_000_000_000n - 1_000_000n; // 1ms before the reset deadline
    const redisRenewBatch2 = vi
      .fn()
      .mockImplementation(() => Promise.reject(new Error('now actually hung')));
    (leaseRedis as { renewBatch: unknown }).renewBatch = redisRenewBatch2;
    await heartbeat.tick();
    expect(sessionOwner.onFenceLost).not.toHaveBeenCalled();

    monotonicNs = 1_999_000_000n + 15_000_000_000n; // exactly at the reset deadline
    await heartbeat.tick();
    expect(sessionOwner.onFenceLost).toHaveBeenCalledWith('inst-slow-redis', 'watchdog');
    expect(sessionOwner.onFenceLost).toHaveBeenCalledTimes(1);
  });
});
