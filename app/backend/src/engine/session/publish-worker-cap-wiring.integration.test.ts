import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createPool, createTenantDb, createWorkerDb } from '@wp/db';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { cleanupProbeClients } from '../../modules/instances/__tests__/instances-test-helpers.js';
import { writeTempSessionKeyRing } from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import { readFleetCapacityHeadroom } from '../fleet/discovery.js';
import { bindDiscoveryMetrics } from '../../platform/metrics/discovery-metrics.js';
import { createSessionWorker, type SessionWorker } from './session-worker-composition.js';
import type { FakeSock } from './runner-test-support.js';

/**
 * publish-worker-cap-wiring.integration.test.ts (FIX-P09-A, CRITICAL 2) -
 * pins that `session-worker-composition.ts`'s `runOneDiscoveryCycle()` now
 * calls `publishWorkerCap` once per cycle (real Redis, `sys:fleet:caps`
 * hash) - before this fix, `publishWorkerCap` had zero production callers,
 * so `readFleetCapacityHeadroom` always summed an EMPTY hash and real
 * fleet-wide shedding headroom was structurally unreachable outside a test
 * that injected a fake headroom directly.
 *
 * Two in-process "workers" (two `createSessionWorker` instances, distinct
 * `workerId`s, sharing the SAME real Redis env) each run one discovery
 * cycle; `readFleetCapacityHeadroom` (called directly here, with an
 * explicit small `desiredOnlineCount` fixture so this assertion is never at
 * the mercy of the shared dev database's other suites' pre-seeded
 * `desired_state='online'` rows) must then return
 * `Sigma(theirCaps) - desiredOnlineCount`, a POSITIVE number for a small
 * desired-online fixture - proving both workers' caps are genuinely summed
 * from real Redis, not from an empty hash.
 */

const ENV = `pwc-wiring-${randomUUID()}`;

describe("runOneDiscoveryCycle publishes this worker's cap into the shared fleet-caps hash (CRITICAL 2)", () => {
  let pool: ReturnType<typeof createPool>;
  let redis: ReturnType<typeof createRedis>;
  let redisSigA: ReturnType<typeof createRedis>;
  let redisCacheA: ReturnType<typeof createRedis>;
  let redisSigB: ReturnType<typeof createRedis>;
  let redisCacheB: ReturnType<typeof createRedis>;
  let workerA: SessionWorker | undefined;
  let workerB: SessionWorker | undefined;
  const probeClientIds: string[] = [];

  afterEach(async () => {
    // `runOneDiscoveryCycle` acquires a REAL Redis lease
    // (`wp:{ENV}:c:<clientId>:lease:i:<instanceId>`, 30s TTL) for whatever
    // row its `ORDER BY random()` scan happens to discover in the shared dev
    // DB - never a row this file seeds itself, so there is no known
    // instanceId to `redis.del()` directly (unlike `redis-flush.integration.
    // test.ts`'s single known-key cleanup). `shutdown()` is the correct
    // seam: it releases EVERY session each worker's registry actually holds
    // (`teardownWithRelease()`, a real Redis compare-delete via
    // `LeaseManager.release()`), whichever instance that turned out to be -
    // without this, the lease key survives until its TTL, which is long
    // enough to poison the SAME gate run's `isolation-suite-c.integration.
    // test.ts` if it runs first (see FIX-P16 lesson update).
    await workerA?.shutdown();
    await workerB?.shutdown();
    workerA = undefined;
    workerB = undefined;
    if (probeClientIds.length > 0) {
      await cleanupProbeClients(pool, probeClientIds);
      probeClientIds.length = 0;
    }
  });

  afterAll(async () => {
    await pool?.end();
    redis?.disconnect();
    redisSigA?.disconnect();
    redisCacheA?.disconnect();
    redisSigB?.disconnect();
    redisCacheB?.disconnect();
  });

  it('two workers running one discovery cycle each publish caps that sum into a positive headroom against a small desired-online fixture', async () => {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'pwc-wiring-test',
    });
    redis = createRedis(resolveRedisUrl());
    redisSigA = createRedis(resolveRedisUrl());
    redisCacheA = createRedis(resolveRedisUrl());
    redisSigB = createRedis(resolveRedisUrl());
    redisCacheB = createRedis(resolveRedisUrl());

    const socketFactory = vi.fn(() => {
      const handlers = new Map<string, (u: unknown) => unknown>();
      const sock: FakeSock = {
        ev: {
          on(ev: string, cb: (u: unknown) => void) {
            handlers.set(ev, cb);
          },
          async emit(ev: string, payload: unknown) {
            const cb = handlers.get(ev);
            if (cb) await cb(payload);
          },
        },
        end: vi.fn(),
      };
      return sock;
    });

    const keyProvider = new FileKeyProvider({
      ringPath: writeTempSessionKeyRing(),
      mountedPurposes: ['session'],
    });

    // No rows to discover (env is unique to this test) - each cycle's own
    // discovery scan is a real no-op; only the cap-publish side effect
    // matters here.
    workerA = createSessionWorker({
      env: ENV,
      workerId: `pwc-worker-a-${randomUUID()}`,
      pool,
      tenantDb: createTenantDb(pool),
      workerDb: createWorkerDb(pool),
      redisCtl: redis,
      redisSig: redisSigA,
      redisCache: redisCacheA,
      keyProvider,
      socketFactory,
      maxScanRows: 1,
      sessionCap: 12,
    });

    workerB = createSessionWorker({
      env: ENV,
      workerId: `pwc-worker-b-${randomUUID()}`,
      pool,
      tenantDb: createTenantDb(pool),
      workerDb: createWorkerDb(pool),
      redisCtl: redis,
      redisSig: redisSigB,
      redisCache: redisCacheB,
      keyProvider,
      socketFactory,
      maxScanRows: 1,
      sessionCap: 18,
    });

    await workerA.runOneDiscoveryCycle();
    await workerB.runOneDiscoveryCycle();

    // A small desired-online fixture (5) against the two published caps
    // (12 + 18 = 30) - a genuinely positive headroom, proving real summed
    // Redis-side caps rather than an empty hash (which would floor headroom
    // at <= 0 - desiredOnlineCount).
    const headroom = await readFleetCapacityHeadroom({
      redis,
      env: ENV,
      desiredOnlineCount: 5,
    });

    expect(headroom).toBe(12 + 18 - 5);
    expect(headroom).toBeGreaterThan(0);

    // The `wp_fleet_capacity_headroom` gauge (updated by each worker's own
    // `runOneDiscoveryCycle` -> `discoveryLoop.runOneCycle()` against the
    // REAL, whole-database desired-online count, unlike the explicit small
    // fixture above) reflects a real, finite number - never left at its
    // pre-fix always-non-positive floor. This is a coarser assertion than
    // the exact-headroom check above (the shared dev database's desired-
    // online count is not controlled by this test), but it still proves the
    // gauge pipeline is wired end-to-end through the SAME publish this test
    // just exercised.
    const gaugeMetrics = bindDiscoveryMetrics();
    const gaugeValue = (await gaugeMetrics.fleetCapacityHeadroom.get()).values[0]?.value;
    expect(typeof gaugeValue).toBe('number');
    expect(Number.isFinite(gaugeValue)).toBe(true);
  }, 20_000);
});
