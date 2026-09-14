import { createPool, createTenantDb } from '@wp/db';
import { TIMING } from '@wp/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { resolveRedisUrl, createRedis, tenantKey, sysKey } from '../../platform/redis.js';
import {
  cleanupChargerRedisKeys,
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { createChargerWorker, type ChargerRedis } from './charger.worker.js';

/**
 * wallet-edge-cases-charger-queue.integration.test.ts (P18 C2 hardening) -
 * the charger worker's own Redis-facing edge cases: a bounded list under a
 * huge enqueue burst, per-call item/client bounding + client re-indexing,
 * and a `lpush` that never resolves - asserted against the ENFORCED
 * `TIMING.redisCommandTimeoutMs` bound under fake timers: `enqueue` settles,
 * warns once with `{client_id, send_attempt_id}` only, and never throws.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const REDIS_ENV = 'test'; // must satisfy the `[a-z]+` env grammar (was 'test-wallet-edge-charger-queue')

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wallet-edge-charger-queue-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupChargerRedisKeys(REDIS_ENV, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('charger worker - queue bounding (real Redis)', () => {
  it('a_huge_enqueue_burst_is_bounded_to_maxQueueLength_and_drainOnce_bounds_items_per_client', async () => {
    const redis = createRedis(resolveRedisUrl());
    try {
      // Best-effort clean slate: a previous, unrelated failed run under the
      // SAME fixed REDIS_ENV could have left stale client ids in the
      // pending-index set, which would make spop() return more than this
      // test's own one client.
      await redis.del(sysKey(REDIS_ENV, 'sys', 'wallet', 'charge-pending'));

      const tenant = await seedSendTenant(pool, probeClientIds);
      const tenantDb = createTenantDb(pool);
      const worker = createChargerWorker({
        redis,
        env: REDIS_ENV,
        tenantDb,
        maxQueueLength: 1000,
        maxItemsPerClient: 200,
      });

      for (let i = 0; i < 1005; i += 1) {
        await worker.enqueue({ clientId: tenant.clientId, attemptId: String(1_000_000 + i) });
      }

      const listKey = tenantKey(REDIS_ENV, tenant.clientId, 'charge');
      const listLength = await redis.llen(listKey);
      expect(listLength).toBe(1000);

      const result = await worker.drainOnce();
      // Every popped "attemptId" is a non-existent send_attempts row, so
      // chargeRepairedSend resolves it as null (0 jobRows/guardRows) -
      // asserting the BOUND on how many are processed per call, not that
      // they successfully charged.
      expect(result.clients).toBe(1);
      expect(result.noop + result.failed).toBeLessThanOrEqual(200);
      expect(result.noop + result.failed).toBeGreaterThan(0);

      const remainingLength = await redis.llen(listKey);
      expect(remainingLength).toBe(1000 - (result.noop + result.failed));

      // The client was re-indexed into the pending set (more work remains)
      // - a second drainOnce() call keeps making progress.
      const pendingKey = sysKey(REDIS_ENV, 'sys', 'wallet', 'charge-pending');
      const stillPending = await redis.sismember(pendingKey, tenant.clientId);
      expect(stillPending).toBe(1);

      let remaining = remainingLength;
      let guardAgainst = 0;
      while (remaining > 0 && guardAgainst < 10) {
        await worker.drainOnce();
        remaining = await redis.llen(listKey);
        guardAgainst += 1;
      }
      expect(remaining).toBe(0);

      // The pop that emptied the list may STILL have been a full
      // (maxItemsPerClient-sized) pop, which drainOnce() re-indexes
      // unconditionally (it cannot know a full pop was also the last one) -
      // one more drainOnce() call pops zero items and finally clears the
      // pending set. Bounded to avoid an infinite loop if this regresses.
      let pendingAfterDrain = await redis.sismember(pendingKey, tenant.clientId);
      let extraDrains = 0;
      while (pendingAfterDrain === 1 && extraDrains < 3) {
        await worker.drainOnce();
        pendingAfterDrain = await redis.sismember(pendingKey, tenant.clientId);
        extraDrains += 1;
      }
      expect(pendingAfterDrain).toBe(0);
    } finally {
      redis.disconnect();
    }
  });

  it('a_redis_lpush_that_never_resolves_settles_enqueue_at_the_command_timeout_and_logs_a_warn', async () => {
    // charger.worker.ts's enqueue() races its Redis command sequence against
    // TIMING.redisCommandTimeoutMs (C2 hardening, F2 item 3) - a hung lpush
    // must never stall the reaper's per-row hook indefinitely. On timeout the
    // work item is DROPPED (best-effort, reconciler check B is the backstop):
    // enqueue() resolves, never throws, and warns with client_id +
    // send_attempt_id only.
    vi.useFakeTimers();
    try {
      const neverResolves: ChargerRedis = {
        lpush: () => new Promise<number>(() => undefined),
        ltrim: () => Promise.resolve('OK'),
        sadd: () => Promise.resolve(1),
        spop: () => Promise.resolve([]),
        rpop: () => Promise.resolve(null),
      };
      const tenantDb = createTenantDb(pool);
      const warn = vi.fn();
      const worker = createChargerWorker({
        redis: neverResolves,
        env: REDIS_ENV,
        tenantDb,
        logger: { warn },
      });

      let settled = false;
      const pending = worker
        .enqueue({ clientId: 'never-resolves-client', attemptId: 'x' })
        .then(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(TIMING.redisCommandTimeoutMs);
      await pending;

      expect(settled).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toEqual({
        client_id: 'never-resolves-client',
        send_attempt_id: 'x',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
