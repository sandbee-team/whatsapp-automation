import { describe, expect, it, vi } from 'vitest';
import { TIMING } from '@wp/domain';
import type { WorkerDb, WorkerQueryable } from '@wp/db';
import { LeaseHeartbeat } from './heartbeat.js';
import type { LeaseRedis } from './lease-redis.js';
import type { LeaseQueryable } from './lease-state-repo.js';
import type { SessionOwner } from './session-owner.port.js';
import type { SessionLease } from './lease-manager.js';

/**
 * heartbeat.watchdog-baseline.edge.test.ts (P06 E3 edge pass) - unit-level
 * edge case NOT covered by watchdog.test.ts/heartbeat.integration.test.ts:
 * watchdog deadline RESET after a successful renewal (a prior near-expiry
 * does not carry over). Split out of heartbeat.edge.test.ts (which keeps
 * the mid-tick mutation cases) to stay under the workspace max-lines limit.
 * No real Redis/Postgres.
 */

/** Wraps a bare `LeaseQueryable` stub into a `WorkerDb` - see heartbeat.c2.test.ts's identical helper. */
function stubWorkerDb(queryable: LeaseQueryable): WorkerDb {
  return {
    withWorker: (_workerId, fn) => fn(queryable as unknown as WorkerQueryable),
  };
}

const COMPRESSED_TIMING = {
  ...TIMING,
  heartbeatMs: 1_000,
  watchdogMs: 15_000,
  leaseTtlMs: 30_000,
  redisCommandTimeoutMs: 2_000,
} as const;

function makeLease(instanceId: string): SessionLease {
  return {
    instanceId,
    clientId: `client-${instanceId}`,
    fence: 1n,
    workerId: 'worker-1',
    graceMs: 0,
  };
}

function makeSessionOwner(): SessionOwner {
  return { onFenceLost: vi.fn(), close: vi.fn() };
}

describe('watchdog deadline reset after recovery', () => {
  it('successful_renewal_resets_the_monotonic_deadline_prior_near_expiry_does_not_fire_after_recovery', async () => {
    let monotonicNs = 0n;
    const monotonicNow = (): bigint => monotonicNs;

    // Tick 1: renew SUCCEEDS (redis true, pg ok+renewed) - baseline reset to
    // "now" (monotonicNs = 0).
    const renewBatchMock = vi.fn();
    const leaseRedis: LeaseRedis = {
      acquire: vi.fn(),
      setFence: vi.fn(),
      renewBatch: renewBatchMock as unknown as LeaseRedis['renewBatch'],
      release: vi.fn(),
    };
    const pgSql: WorkerDb = stubWorkerDb({ query: vi.fn() });
    const sessionOwner = makeSessionOwner();
    const lease = makeLease('inst-recover');

    const heartbeat = new LeaseHeartbeat({
      leaseRedis,
      pgSql,
      sessionOwner,
      workerId: 'worker-1',
      env: 'test',
      timing: COMPRESSED_TIMING as unknown as typeof TIMING,
      monotonicNow,
    });
    heartbeat.add(lease);

    // Advance to just 1ms before the watchdog deadline (14_999ms) WITHOUT
    // any successful renewal yet - prove we are right on the edge of firing.
    renewBatchMock.mockResolvedValueOnce([undefined]); // simulate: redis call resolved with no per-instance signal is not realistic;
    // Use a rejected call instead so nothing resets the baseline (matches
    // watchdog.test.ts's own hung-connection shape).
    renewBatchMock.mockReset();
    renewBatchMock.mockImplementation(() => Promise.reject(new Error('redis hung')));

    monotonicNs = 14_999_000_000n; // 14_999ms in ns
    await heartbeat.tick();
    expect(sessionOwner.onFenceLost).not.toHaveBeenCalled();

    // Now a tick where the renewal ACTUALLY SUCCEEDS (redis true) - this
    // must reset the watchdog baseline to "now" (14_999ms), even though we
    // were 1ms from firing.
    renewBatchMock.mockReset();
    renewBatchMock.mockResolvedValue([true]);
    await heartbeat.tick();
    expect(sessionOwner.onFenceLost).not.toHaveBeenCalled();

    // Without the reset, advancing another 14_999ms (total 29_998ms from
    // t=0) would have crossed the ORIGINAL 15_000ms deadline long ago. With
    // the reset, the new deadline is baseline(14_999ms) + 15_000ms =
    // 29_999ms - so at 29_998ms total we must STILL not have fenced.
    renewBatchMock.mockReset();
    renewBatchMock.mockImplementation(() => Promise.reject(new Error('redis hung again')));
    monotonicNs = 29_998_000_000n; // 1ms before the RESET deadline
    await heartbeat.tick();
    expect(sessionOwner.onFenceLost).not.toHaveBeenCalled();

    // Crossing the reset deadline (29_999ms) DOES fire.
    monotonicNs = 29_999_000_000n;
    await heartbeat.tick();
    expect(sessionOwner.onFenceLost).toHaveBeenCalledWith('inst-recover', 'watchdog');
    expect(sessionOwner.onFenceLost).toHaveBeenCalledTimes(1);
  });
});
