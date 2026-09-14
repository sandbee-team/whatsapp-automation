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
 * admission-edge.integration.test.ts (P21 E3 hardening) - real Redis proofs
 * beyond the sibling `admission.integration.test.ts`: the clock going
 * BACKWARDS between calls never grants negative or runaway tokens, the key
 * TTL is bounded (> 0 and <= 120000ms), and two independent
 * `createInboundAdmission` instances sharing the SAME Redis bucket never
 * admit more than the ceiling in total (never a per-instance-in-memory
 * illusion of capacity).
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
    applicationName: 'inbound-admission-edge-test',
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

describe('inbound admission bucket edge cases (real Redis + real Postgres)', () => {
  it('the_clock_going_backwards_never_grants_negative_or_runaway_tokens', async () => {
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

    let now = 100_000;
    const admission = createInboundAdmission({
      env: ENV,
      bucket,
      readLimit: readInboundLimitFromDb(tenantDb),
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => now,
      metrics,
    });

    // Drain the bucket of its 5 tokens at t=100000.
    for (let i = 0; i < 5; i++) {
      expect(await admission.admit(clientId, instanceId)).toBe('admitted');
    }
    expect(await admission.admit(clientId, instanceId)).toBe('shed');

    // Clock goes BACKWARDS by 50 seconds (nowMs < stored ts). The Lua
    // script's `elapsedMs = nowMs - ts` is now negative; its own `if
    // elapsedMs > 0` guard means no refill happens (never a negative
    // token count either) - tokens stay at 0, ts is overwritten to the
    // smaller value.
    now = 50_000;
    const decisionsAfterClockRewind: string[] = [];
    for (let i = 0; i < 3; i++) {
      decisionsAfterClockRewind.push(await admission.admit(clientId, instanceId));
    }
    expect(decisionsAfterClockRewind).toEqual(['shed', 'shed', 'shed']);

    // Advancing forward again from the REWOUND ts (50000) by exactly one
    // minute's worth (60000ms elapsed, limit 5/min -> full 5-token refill)
    // must land at exactly 5 admits again - never more than the ceiling
    // regardless of the clock's prior excursion backwards.
    now = 50_000 + 60_000;
    const decisionsAfterForwardRefill: string[] = [];
    for (let i = 0; i < 6; i++) {
      decisionsAfterForwardRefill.push(await admission.admit(clientId, instanceId));
    }
    expect(decisionsAfterForwardRefill.filter((d) => d === 'admitted')).toHaveLength(5);
    expect(decisionsAfterForwardRefill.filter((d) => d === 'shed')).toHaveLength(1);
  }, 30_000);

  it('the_bucket_key_ttl_is_always_positive_and_never_exceeds_120_seconds', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const key = tenantKey(ENV, clientId, 'inbound', 'i', instanceId);
    probeKeys.push(key);

    const tenantDb = createTenantDb(pool);
    const bucket = bindInboundBucketCommand(redis);
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    const admission = createInboundAdmission({
      env: ENV,
      bucket,
      readLimit: readInboundLimitFromDb(tenantDb),
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => 0,
      metrics,
    });

    await admission.admit(clientId, instanceId);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120_000);
  }, 30_000);

  it('two_worker_admission_instances_sharing_one_bucket_never_admit_more_than_the_ceiling_in_total', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await pool.query('UPDATE whatsapp_instances SET inbound_max_per_minute = 5 WHERE id = $1', [
      instanceId,
    ]);
    const key = tenantKey(ENV, clientId, 'inbound', 'i', instanceId);
    probeKeys.push(key);

    const tenantDb = createTenantDb(pool);
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    // Two INDEPENDENT admission instances (simulating two workers), each
    // with its OWN Lua-command binding on the SAME Redis connection/bucket
    // key - the fixed clock (0) means every call sees the same starting
    // state and only the shared Redis hash arbitrates admits.
    const admissionA = createInboundAdmission({
      env: ENV,
      bucket: bindInboundBucketCommand(redis),
      readLimit: readInboundLimitFromDb(tenantDb),
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => 0,
      metrics,
    });
    const admissionB = createInboundAdmission({
      env: ENV,
      bucket: bindInboundBucketCommand(redis),
      readLimit: readInboundLimitFromDb(tenantDb),
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => 0,
      metrics,
    });

    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => admissionA.admit(clientId, instanceId)),
      ...Array.from({ length: 10 }, () => admissionB.admit(clientId, instanceId)),
    ]);

    // Never assert which worker "won" which slot (a sampled race outcome) -
    // only the exact invariant: the SUM of admits across both workers
    // never exceeds the shared ceiling.
    expect(results.filter((r) => r === 'admitted')).toHaveLength(5);
    expect(results.filter((r) => r === 'shed')).toHaveLength(15);
  }, 30_000);
});
