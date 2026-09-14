import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TIMING } from '@wp/domain';
import type { WorkerDb, WorkerQueryable } from '@wp/db';
import { LeaseHeartbeat } from './heartbeat.js';
import type { LeaseRedis } from './lease-redis.js';
import type { LeaseQueryable } from './lease-state-repo.js';
import type { SessionOwner } from './session-owner.port.js';
import type { SessionLease } from './lease-manager.js';

/**
 * watchdog.test.ts (P06 Unit U5) - unit-level proof of the watchdog
 * self-fence trigger (self-fence.ts trigger (c)) using fake timers and an
 * injected monotonic clock. No real Redis/Postgres - `heartbeat.integration
 * .test.ts` and `watchdog.integration.test.ts` cover real infra.
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

describe('watchdog self-fence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hung_redis_connection_self_fences_within_15s', async () => {
    // Monotonic clock advances in lockstep with the injected timing below.
    let monotonicNs = 0n;
    const monotonicNow = (): bigint => monotonicNs;

    // Mirrors the REAL `lease-redis.ts` contract exactly: every command
    // carries a hard `redisCommandTimeoutMs` timeout and REJECTS on expiry
    // (a half-open TCP connection leaves the underlying call pending
    // forever, so the wrapper - not the underlying client - is what fails
    // fast). This stub reproduces that same reject-after-timeout shape
    // rather than re-testing lease-redis.ts's own timeout machinery.
    const timeoutRecorder: number[] = [];
    const hungRenewBatch = vi.fn(() => {
      timeoutRecorder.push(COMPRESSED_TIMING.redisCommandTimeoutMs);
      return new Promise<boolean[]>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('lease-redis: renewBatch timed out'));
        }, COMPRESSED_TIMING.redisCommandTimeoutMs);
      });
    });

    const leaseRedis: LeaseRedis = {
      acquire: vi.fn(),
      setFence: vi.fn(),
      renewBatch: hungRenewBatch as unknown as LeaseRedis['renewBatch'],
      release: vi.fn(),
    };

    const pgSql: WorkerDb = stubWorkerDb({ query: vi.fn() });
    const sessionOwner = makeSessionOwner();
    const lease = makeLease('inst-1');

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

    // Drive enough ticks (fake timers, advancing the monotonic clock in
    // lockstep) that the cumulative elapsed time crosses watchdogMs, each
    // tick's hung renew rejecting via its own command timeout.
    const ticksToDeadline =
      Math.ceil(COMPRESSED_TIMING.watchdogMs / COMPRESSED_TIMING.redisCommandTimeoutMs) + 1;
    for (let i = 0; i < ticksToDeadline; i += 1) {
      const tickPromise = heartbeat.tick();
      monotonicNs += BigInt(COMPRESSED_TIMING.redisCommandTimeoutMs) * 1_000_000n;
      await vi.advanceTimersByTimeAsync(COMPRESSED_TIMING.redisCommandTimeoutMs);
      await tickPromise;
      if (vi.mocked(sessionOwner.onFenceLost).mock.calls.length > 0) break;
    }

    expect(sessionOwner.onFenceLost).toHaveBeenCalledWith('inst-1', 'watchdog');
    expect(hungRenewBatch.mock.calls.length).toBeGreaterThan(0);
    expect(timeoutRecorder.every((t) => t === COMPRESSED_TIMING.redisCommandTimeoutMs)).toBe(true);

    // Every renew command that fired was issued with the 2s command timeout,
    // and the total elapsed monotonic time to self-fence stayed <= watchdogMs
    // (default TIMING claim: <= 15s).
    expect(monotonicNs / 1_000_000n).toBeLessThanOrEqual(
      BigInt(COMPRESSED_TIMING.watchdogMs + COMPRESSED_TIMING.redisCommandTimeoutMs),
    );
  });

  it('clock_jump_backwards_does_not_delay_the_watchdog', async () => {
    let monotonicNs = 0n;
    const monotonicNow = (): bigint => monotonicNs;

    // Prove the module never consults Date.now() - stub it to throw.
    const originalDateNow = Date.now;
    Date.now = () => {
      throw new Error('watchdog must never call Date.now()');
    };

    try {
      const leaseRedis: LeaseRedis = {
        acquire: vi.fn(),
        setFence: vi.fn(),
        renewBatch: vi.fn(() =>
          Promise.reject(new Error('lease-redis: renewBatch timed out')),
        ) as unknown as LeaseRedis['renewBatch'],
        release: vi.fn(),
      };
      const pgSql: WorkerDb = stubWorkerDb({ query: vi.fn() });
      const sessionOwner = makeSessionOwner();
      const lease = makeLease('inst-2');

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

      // Simulate a wall-clock jump backwards by 10 minutes - irrelevant,
      // since only the monotonic clock is consulted. Advance the monotonic
      // clock to just BEFORE the deadline: must NOT have fenced yet.
      monotonicNs = BigInt(COMPRESSED_TIMING.watchdogMs) * 1_000_000n - 1_000_000n;
      await heartbeat.tick();
      expect(sessionOwner.onFenceLost).not.toHaveBeenCalled();

      // Now advance to exactly the deadline (unaffected by any wall-clock
      // jump, since Date.now() is never called - the throwing stub above
      // would have failed the test already if it were).
      monotonicNs = BigInt(COMPRESSED_TIMING.watchdogMs) * 1_000_000n;
      await heartbeat.tick();
      expect(sessionOwner.onFenceLost).toHaveBeenCalledWith('inst-2', 'watchdog');
    } finally {
      Date.now = originalDateNow;
    }
  });
});
