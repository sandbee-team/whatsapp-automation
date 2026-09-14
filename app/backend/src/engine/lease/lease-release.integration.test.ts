import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRedis, resolveRedisUrl, tenantKey } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { LeaseManager } from './lease-manager.js';
import { createLeaseRedis, type LeaseRedis } from './lease-redis.js';
import type { SessionOwner } from './session-owner.port.js';

/**
 * lease-release.integration.test.ts (P06 Unit U5) - real Redis + real
 * Postgres proof of `LeaseManager.release()`'s grace-skip authority: a
 * clean, recent (< 60s) `released_at` lets the NEXT acquirer skip
 * `takeoverGraceMs`; an older `released_at` still costs the full grace
 * (same as a never-released instance).
 */

type TestPool = ReturnType<typeof createPool>;
type TestRedis = ReturnType<typeof createRedis>;

let pool: TestPool;
let redis: TestRedis;

const ENV = 'test';
const COMPRESSED_TIMING = {
  leaseTtlMs: 5_000,
  heartbeatMs: 200,
  takeoverGraceMs: 150,
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
let probeKeys: string[] = [];

afterEach(async () => {
  if (probeKeys.length > 0) {
    await redis.del(...probeKeys);
    probeKeys = [];
  }
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    probeClientIds = [];
  }
});

async function seedTenantAndInstance(): Promise<{ clientId: string; instanceId: string }> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Lease Release Probe Client',
    `lease-release-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, $3, 'connected', 0)`,
    [instanceId, clientId, 'probe'],
  );

  probeClientIds.push(clientId);
  probeKeys.push(tenantKey(ENV, clientId, 'lease', 'i', instanceId));
  return { clientId, instanceId };
}

function makeSessionOwner(): SessionOwner {
  return { onFenceLost: vi.fn(), close: vi.fn() };
}

function makeManager(
  workerId: string,
  sleepSpy: (ms: number) => void,
  leaseRedis: LeaseRedis,
): LeaseManager {
  return new LeaseManager({
    leaseRedis,
    tenantDb: createTenantDb(pool),
    sessionOwner: makeSessionOwner(),
    timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    sleep: async (ms: number) => {
      sleepSpy(ms);
    },
    workerId,
    env: ENV,
  });
}

describe('LeaseManager.release grace-skip', () => {
  it('graceful_release_lets_the_next_owner_skip_the_grace', async () => {
    const leaseRedis = createLeaseRedis(redis, {
      timeoutMs: COMPRESSED_TIMING.redisCommandTimeoutMs,
    });
    const { clientId, instanceId } = await seedTenantAndInstance();

    const sleepA = vi.fn();
    const managerA = makeManager('worker-a', sleepA, leaseRedis);
    const leaseA = await managerA.acquire({ instanceId, clientId });
    expect(leaseA).not.toBeNull();

    // Clean, voluntary release.
    await managerA.release(leaseA!);

    const releasedRow = await pool.query<{ released_at: Date | null }>(
      'SELECT released_at FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(releasedRow.rows[0]?.released_at).not.toBeNull();

    // A second worker's acquire must report a skipped takeover grace
    // (`graceMs === 0`). `acquire()` itself never calls `sleep` any more
    // (P09 fleet-recovery FIX - the duration is returned via
    // `SessionLease.graceMs`, never awaited inline), so `sleepB` staying
    // uncalled is no longer meaningful on its own; `graceMs` is the real
    // assertion now.
    const sleepB = vi.fn();
    const managerB = makeManager('worker-b', sleepB, leaseRedis);
    const leaseB = await managerB.acquire({ instanceId, clientId });

    expect(leaseB).not.toBeNull();
    expect(sleepB).not.toHaveBeenCalled();
    expect(leaseB?.graceMs).toBe(0);
    expect(leaseB!.fence).toBeGreaterThan(leaseA!.fence);
  }, 30_000);

  it('a_released_lease_older_than_60s_still_costs_the_full_grace', async () => {
    const leaseRedis = createLeaseRedis(redis, {
      timeoutMs: COMPRESSED_TIMING.redisCommandTimeoutMs,
    });
    const { clientId, instanceId } = await seedTenantAndInstance();

    const sleepA = vi.fn();
    const managerA = makeManager('worker-a', sleepA, leaseRedis);
    const leaseA = await managerA.acquire({ instanceId, clientId });
    expect(leaseA).not.toBeNull();

    await managerA.release(leaseA!);

    // Backdate released_at to > 60s ago via direct SQL.
    await pool.query(
      "UPDATE instance_lease_state SET released_at = now() - interval '90 seconds' WHERE instance_id = $1",
      [instanceId],
    );

    const sleepB = vi.fn();
    const managerB = makeManager('worker-b', sleepB, leaseRedis);
    const leaseB = await managerB.acquire({ instanceId, clientId });

    expect(leaseB).not.toBeNull();
    // `acquire()` never calls `sleep` (P09 fleet-recovery FIX) - the full
    // grace duration is reported via `graceMs` for the caller to wait out,
    // deferred/cancellable, instead.
    expect(sleepB).not.toHaveBeenCalled();
    expect(leaseB?.graceMs).toBe(COMPRESSED_TIMING.takeoverGraceMs);
  }, 30_000);
});
