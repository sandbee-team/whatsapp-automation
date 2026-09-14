import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { claimOne } from '../../modules/queue/index.js';
import {
  cleanupProbeClients,
  ctxFor,
  DEFAULT_CLAIM_INPUT,
  getJob,
  seedJob,
  seedTenant,
} from '../../modules/queue/__tests__/claim-test-helpers.js';
import { createRedis, resolveRedisUrl, tenantKey } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { LeaseManager } from './lease-manager.js';
import { createLeaseRedis } from './lease-redis.js';
import { bindLeaseMetrics } from '../../platform/metrics/lease-metrics.js';
import type { SessionOwner } from './session-owner.port.js';

/**
 * redis-flush.integration.test.ts (P06 Unit U5, mandatory test 5) - a
 * `FLUSHALL` mid-run wipes every lease placeholder/fence key, simulating a
 * total Redis data loss. Postgres stays the source of truth: the next
 * acquire still mints a STRICTLY higher fence (mintFence's monotonic
 * upsert does not depend on Redis at all), and claiming resumes with that
 * new fence - `wp_fence_regression_total` must stay at 0 throughout (the
 * canary never legitimately fires here, since Postgres's fence sequence was
 * never touched by the flush).
 */

type TestPool = ReturnType<typeof createPool>;
type TestRedis = ReturnType<typeof createRedis>;

let pool: TestPool;
let redis: TestRedis;

const ENV = 'test';
const COMPRESSED_TIMING = {
  leaseTtlMs: 5_000,
  heartbeatMs: 200,
  takeoverGraceMs: 100,
  watchdogMs: 2_000,
  sendTimeoutMs: 1000,
  claimExpiryMs: 2000,
  reaperGraceMs: 500,
  reconcileWindowMs: 5000,
  redisCommandTimeoutMs: 1_000,
} as const;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  redis = createRedis(resolveRedisUrl());
});

afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

let probeClientIds: string[] = [];

afterEach(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

function makeSessionOwner(): SessionOwner {
  return { onFenceLost: vi.fn(), close: vi.fn() };
}

describe('redis flush does not deadlock claims', () => {
  it('redis_flush_does_not_deadlock_claims', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds, { fence: 1 });
    const jobId = await seedJob(pool, { clientId, instanceId });

    const leaseRedis = createLeaseRedis(redis, {
      timeoutMs: COMPRESSED_TIMING.redisCommandTimeoutMs,
    });
    const tenantDb = createTenantDb(pool);
    const registry = createMetricsRegistry();
    const leaseMetrics = bindLeaseMetrics(registry);

    // Worker A holds a lease.
    const managerA = new LeaseManager({
      leaseRedis,
      tenantDb,
      sessionOwner: makeSessionOwner(),
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
      sleep: async () => undefined,
      metrics: leaseMetrics,
      workerId: 'worker-a',
      env: ENV,
    });
    const leaseA = await managerA.acquire({ instanceId, clientId });
    expect(leaseA).not.toBeNull();

    // FLUSHALL mid-run - wipes every Redis key, including A's lease key.
    await redis.flushall();

    // Next acquire (worker B, compressed grace) mints a STRICTLY higher
    // fence - Postgres never lost its monotonic sequence, and with the
    // placeholder key gone, B's NX acquire succeeds immediately.
    const managerB = new LeaseManager({
      leaseRedis,
      tenantDb,
      sessionOwner: makeSessionOwner(),
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
      sleep: async () => undefined,
      metrics: leaseMetrics,
      workerId: 'worker-b',
      env: ENV,
    });
    const leaseB = await managerB.acquire({ instanceId, clientId });

    expect(leaseB).not.toBeNull();
    expect(leaseB!.fence).toBeGreaterThan(leaseA!.fence);

    // claimOne with the new fence claims the job - claiming resumes.
    const claimed = await claimOne(ctxFor(clientId, pool), {
      instanceId,
      ...DEFAULT_CLAIM_INPUT,
      fence: Number(leaseB!.fence),
    });
    expect(claimed?.id).toBe(jobId);

    const jobAfter = await getJob(pool, jobId);
    expect(jobAfter.status).toBe('processing');

    const metricsText = await registry.metricsText();
    const regressionLine = metricsText
      .split('\n')
      .find((l) => l.startsWith('wp_fence_regression_total') && !l.startsWith('#'));
    const regressionValue = regressionLine ? Number(regressionLine.split(' ').at(-1)) : 0;
    expect(regressionValue).toBe(0);

    // Cleanup: worker B's placeholder/fence key.
    await redis.del(tenantKey(ENV, clientId, 'lease', 'i', instanceId));
  }, 30_000);
});
