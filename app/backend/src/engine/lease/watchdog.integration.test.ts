import { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIMING } from '@wp/domain';
import type { WorkerDb, WorkerQueryable } from '@wp/db';
import { LeaseHeartbeat } from './heartbeat.js';
import { createLeaseRedis } from './lease-redis.js';
import type { LeaseQueryable } from './lease-state-repo.js';
import { createHungTcpProxy, type HungTcpProxy } from './test-support/hung-tcp-proxy.js';
import type { SessionOwner } from './session-owner.port.js';
import type { SessionLease } from './lease-manager.js';

/** Wraps a bare `LeaseQueryable` stub into a `WorkerDb` - see heartbeat.c2.test.ts's identical helper. */
function stubWorkerDb(queryable: LeaseQueryable): WorkerDb {
  return {
    withWorker: (_workerId, fn) => fn(queryable as unknown as WorkerQueryable),
  };
}

/**
 * watchdog.integration.test.ts (P06 Unit U5) - REAL Redis client (ioredis)
 * pointed at a half-open TCP proxy that accepts the connection and never
 * replies, proving `lease-redis.ts`'s hard command timeout plus
 * `heartbeat.ts`'s watchdog trigger together self-fence within the
 * configured `watchdogMs` against a genuinely hung TCP connection - not
 * merely a rejected/never-resolving promise stub (that is
 * `watchdog.test.ts`'s job).
 */

let proxy: HungTcpProxy | undefined;
let redis: Redis | undefined;

afterEach(async () => {
  if (redis) {
    redis.disconnect();
    redis = undefined;
  }
  if (proxy) {
    await proxy.close();
    proxy = undefined;
  }
});

describe('half-open TCP self-fence', () => {
  it('half_open_tcp_self_fences_within_15s', async () => {
    proxy = createHungTcpProxy();
    await proxy.listen();

    redis = new Redis({
      host: '127.0.0.1',
      port: proxy.port,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 300,
      retryStrategy: () => null,
    });
    redis.on('error', () => undefined); // swallow expected connection-level errors from the silent proxy

    const COMMAND_TIMEOUT_MS = 200;
    const HEARTBEAT_MS = 500;
    const WATCHDOG_MS = 1_500;

    const leaseRedis = createLeaseRedis(redis, { timeoutMs: COMMAND_TIMEOUT_MS });
    // PG renew always "succeeds" and renews the held instance - isolates
    // this test to ONLY the Redis-hang -> watchdog path (a `pg_fence_conflict`
    // would otherwise win the heartbeat's fixed redis -> pg -> watchdog
    // decision-priority order before the watchdog ever gets a chance to
    // fire).
    const pgSql: WorkerDb = stubWorkerDb({
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT set_config')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [{ instance_id: 'inst-hung' }] });
      }),
    });
    const sessionOwner: SessionOwner = {
      onFenceLost: vi.fn(),
      close: vi.fn(),
    };

    const timing = {
      ...TIMING,
      heartbeatMs: HEARTBEAT_MS,
      watchdogMs: WATCHDOG_MS,
      redisCommandTimeoutMs: COMMAND_TIMEOUT_MS,
    };

    const heartbeat = new LeaseHeartbeat({
      leaseRedis,
      pgSql,
      sessionOwner,
      workerId: 'worker-1',
      env: 'test',
      timing: timing as unknown as typeof TIMING,
    });

    const lease: SessionLease = {
      instanceId: 'inst-hung',
      clientId: 'client-hung',
      fence: 1n,
      workerId: 'worker-1',
      graceMs: 0,
    };
    heartbeat.add(lease);

    const startedAt = Date.now();
    // Poll ticks until either the watchdog fires or a generous real-time
    // ceiling is hit (proves the ≤ WATCHDOG_MS claim without a real sleep
    // longer than necessary; this loop itself performs the actual ticking).
    while (
      vi.mocked(sessionOwner.onFenceLost).mock.calls.length === 0 &&
      Date.now() - startedAt < WATCHDOG_MS + 5_000
    ) {
      await heartbeat.tick();
    }
    const elapsedMs = Date.now() - startedAt;

    expect(sessionOwner.onFenceLost).toHaveBeenCalledWith('inst-hung', 'watchdog');
    expect(elapsedMs).toBeLessThanOrEqual(WATCHDOG_MS + 1_000); // small real-clock slack for scheduling jitter

    // Static assertion: the default TIMING values satisfy the "≤15s" claim
    // this test's compressed timing is standing in for.
    expect(TIMING.watchdogMs).toBeLessThanOrEqual(15_000);
  }, 20_000);
});
