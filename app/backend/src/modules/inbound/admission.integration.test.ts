import { createPool, createTenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRedis, resolveRedisUrl, tenantKey } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { bindInboundMetrics } from './metrics.js';
import {
  bindInboundBucketCommand,
  createInboundAdmission,
  readInboundLimitFromDb,
} from './admission.js';

/**
 * admission.integration.test.ts (P21 Unit U5, step 6) - real Redis + real
 * Postgres proof of the admission bucket: the ceiling is enforced exactly
 * (never silently dropped - the metric delta equals the shed count exactly)
 * and a Redis-unavailable bucket fails open on every call.
 */

type TestRedis = ReturnType<typeof createRedis>;

const ENV = 'test';

let pool: TestPool;
let redis: TestRedis;
let probeClientIds: string[] = [];
let probeKeys: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'inbound-admission-test',
  });
  redis = createRedis(resolveRedisUrl());
});

afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

afterEach(async () => {
  if (probeKeys.length > 0) {
    await redis.del(...probeKeys);
    probeKeys = [];
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('inbound admission bucket (real Redis + real Postgres)', () => {
  it('inbound_above_the_ceiling_is_shed_and_counted_never_silently_dropped', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await pool.query('UPDATE whatsapp_instances SET inbound_max_per_minute = 5 WHERE id = $1', [
      instanceId,
    ]);

    const key = tenantKey(ENV, clientId, 'inbound', 'i', instanceId);
    probeKeys.push(key);

    const tenantDb = createTenantDb(pool);
    const bucket = bindInboundBucketCommand(redis);
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    const now = 0;
    const admission = createInboundAdmission({
      env: ENV,
      bucket,
      readLimit: readInboundLimitFromDb(tenantDb),
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => now,
      metrics,
    });

    const decisions: string[] = [];
    for (let i = 0; i < 20; i++) {
      decisions.push(await admission.admit(clientId, instanceId));
    }

    expect(decisions.filter((d) => d === 'admitted')).toHaveLength(5);
    expect(decisions.filter((d) => d === 'shed')).toHaveLength(15);
    expect((await metrics.inboundShedTotal.get()).values[0]?.value).toBe(15);

    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
  }, 30_000);

  it('redis_unavailable_fails_open_and_processes_inbound', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);

    const unreachableRedis = createRedis('redis://127.0.0.1:1');
    unreachableRedis.options.lazyConnect = true;
    unreachableRedis.options.maxRetriesPerRequest = 0;

    const tenantDb = createTenantDb(pool);
    const bucket = bindInboundBucketCommand(unreachableRedis, { timeoutMs: 200 });
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    const admission = createInboundAdmission({
      env: ENV,
      bucket,
      readLimit: readInboundLimitFromDb(tenantDb),
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => 0,
      metrics,
      logger: { warn: () => {} },
    });

    const callCount = 5;
    const decisions: string[] = [];
    for (let i = 0; i < callCount; i++) {
      decisions.push(await admission.admit(clientId, instanceId));
    }

    expect(decisions).toEqual(Array(callCount).fill('admitted'));
    expect((await metrics.inboundAdmissionFailOpenTotal.get()).values[0]?.value).toBe(callCount);

    unreachableRedis.disconnect();
  }, 30_000);
});
