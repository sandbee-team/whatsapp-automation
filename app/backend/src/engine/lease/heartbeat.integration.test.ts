import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, createWorkerDb, type WorkerDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRedis, resolveRedisUrl, tenantKey } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { LeaseHeartbeat } from './heartbeat.js';
import { LeaseManager, type SessionLease } from './lease-manager.js';
import { createLeaseRedis, type LeaseRedis } from './lease-redis.js';
import type { SessionOwner } from './session-owner.port.js';

/**
 * heartbeat.integration.test.ts (P06 Unit U5) - real Redis + real Postgres,
 * acquiring N session leases via `LeaseManager` and driving `LeaseHeartbeat`
 * ticks directly (no real interval timer - `tick()` called explicitly, so
 * this test controls exactly how many round trips happen without any
 * sleep). Compressed timing so `acquire`'s takeover grace never costs real
 * wall time.
 */

type TestPool = ReturnType<typeof createPool>;
type TestRedis = ReturnType<typeof createRedis>;

let pool: TestPool;
let redis: TestRedis;

const ENV = 'test';
const COMPRESSED_TIMING = {
  leaseTtlMs: 5_000,
  heartbeatMs: 200,
  takeoverGraceMs: 50,
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
    'Heartbeat Probe Client',
    `heartbeat-probe-${clientId}`,
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

async function acquireN(
  count: number,
  leaseRedis: LeaseRedis,
  tenantDb: ReturnType<typeof createTenantDb>,
  workerId: string,
): Promise<SessionLease[]> {
  const leases: SessionLease[] = [];
  for (let i = 0; i < count; i += 1) {
    const { clientId, instanceId } = await seedTenantAndInstance();
    const manager = new LeaseManager({
      leaseRedis,
      tenantDb,
      sessionOwner: makeSessionOwner(),
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
      sleep: async () => undefined,
      workerId,
      env: ENV,
    });
    const lease = await manager.acquire({ instanceId, clientId });
    if (!lease) throw new Error(`acquireN: failed to acquire lease ${String(i)}`);
    leases.push(lease);
  }
  return leases;
}

describe('heartbeat batched renew', () => {
  it('batched_renew_covers_every_owned_lease_in_one_round_trip', async () => {
    const leaseRedis = createLeaseRedis(redis, {
      timeoutMs: COMPRESSED_TIMING.redisCommandTimeoutMs,
    });
    const tenantDb = createTenantDb(pool);
    const workerId = 'worker-batch';

    const leases = await acquireN(25, leaseRedis, tenantDb, workerId);

    const renewBatchSpy = vi.spyOn(leaseRedis, 'renewBatch');
    const realWorkerDb = createWorkerDb(pool);
    const pgQuerySpy = vi.fn();
    // Wraps the real WorkerDb's transaction with a spy that observes every
    // statement run against the ONE pinned connection withWorker opens
    // (BEGIN, the app.worker_id set_config, the renew UPDATE, COMMIT) -
    // proving renewBatch still issues exactly one renew UPDATE per tick,
    // now inside withWorker's single transaction rather than as loose pool
    // calls.
    const pgSql: WorkerDb = {
      withWorker: (workerIdArg, fn) =>
        realWorkerDb.withWorker(workerIdArg, (tx) => {
          const spiedTx = {
            query: async (sql: string, params?: unknown[]) => {
              pgQuerySpy(sql, params);
              return tx.query(sql, params);
            },
          };
          return fn(spiedTx as typeof tx);
        }),
    };

    const sessionOwner = makeSessionOwner();
    const heartbeat = new LeaseHeartbeat({
      leaseRedis,
      pgSql,
      sessionOwner,
      workerId,
      env: ENV,
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    });
    leases.forEach((lease) => heartbeat.add(lease));

    await heartbeat.tick();

    expect(renewBatchSpy).toHaveBeenCalledTimes(1);
    // Exactly one renew UPDATE statement against instance_lease_state ran
    // inside the pinned withWorker transaction this tick.
    const renewCalls = pgQuerySpy.mock.calls.filter(([sql]) =>
      (sql as string).includes('instance_lease_state'),
    );
    expect(renewCalls.length).toBe(1);

    expect(sessionOwner.onFenceLost).not.toHaveBeenCalled();

    const rows = await pool.query<{ instance_id: string; lease_seen_at: Date }>(
      'SELECT instance_id, lease_seen_at FROM instance_lease_state WHERE instance_id = ANY($1)',
      [leases.map((l) => l.instanceId)],
    );
    expect(rows.rows.length).toBe(25);
    // All 25 rows have a recent lease_seen_at (renewed within the last few seconds).
    const now = Date.now();
    for (const row of rows.rows) {
      expect(now - new Date(row.lease_seen_at).getTime()).toBeLessThan(10_000);
    }
  }, 30_000);

  it('renew_partial_loss_self_fences_only_the_lost_instance', async () => {
    const leaseRedis = createLeaseRedis(redis, {
      timeoutMs: COMPRESSED_TIMING.redisCommandTimeoutMs,
    });
    const tenantDb = createTenantDb(pool);
    const workerId = 'worker-partial';

    const leases = await acquireN(3, leaseRedis, tenantDb, workerId);
    const lostLease = leases[0];
    if (!lostLease) throw new Error('expected at least one lease');

    // Corrupt/delete ONE lease key in Redis directly.
    const lostKey = tenantKey(ENV, lostLease.clientId, 'lease', 'i', lostLease.instanceId);
    await redis.del(lostKey);

    const pgSql = createWorkerDb(pool);
    const sessionOwner = makeSessionOwner();
    const heartbeat = new LeaseHeartbeat({
      leaseRedis,
      pgSql,
      sessionOwner,
      workerId,
      env: ENV,
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    });
    leases.forEach((lease) => heartbeat.add(lease));

    await heartbeat.tick();

    expect(sessionOwner.onFenceLost).toHaveBeenCalledTimes(1);
    expect(sessionOwner.onFenceLost).toHaveBeenCalledWith(lostLease.instanceId, 'redis_renew_lost');

    const remainingInstanceIds = new Set(heartbeat.held().map((l) => l.instanceId));
    expect(remainingInstanceIds.has(lostLease.instanceId)).toBe(false);
    expect(remainingInstanceIds.size).toBe(2);

    // The other 24/2 keep their leases and keep renewing on a second tick.
    await heartbeat.tick();
    expect(sessionOwner.onFenceLost).toHaveBeenCalledTimes(1); // no additional loss
  }, 30_000);

  it('postgres_unavailability_does_not_self_fence', async () => {
    const leaseRedis = createLeaseRedis(redis, {
      timeoutMs: COMPRESSED_TIMING.redisCommandTimeoutMs,
    });
    const tenantDb = createTenantDb(pool);
    const workerId = 'worker-pg-outage';

    const leases = await acquireN(2, leaseRedis, tenantDb, workerId);

    const failingPgSql: WorkerDb = {
      withWorker: vi.fn().mockRejectedValue(new Error('pg unavailable')),
    };
    const sessionOwner = makeSessionOwner();
    const heartbeat = new LeaseHeartbeat({
      leaseRedis,
      pgSql: failingPgSql,
      sessionOwner,
      workerId,
      env: ENV,
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    });
    leases.forEach((lease) => heartbeat.add(lease));

    // Simulate ~30s of ticks (compressed: several ticks) all failing at PG.
    for (let i = 0; i < 5; i += 1) {
      await heartbeat.tick();
    }

    expect(sessionOwner.onFenceLost).not.toHaveBeenCalled();
    expect(heartbeat.held().length).toBe(2);
    expect(heartbeat.isClaimingAllowed()).toBe(false);

    // Recovery: swap in a working pgSql via a real tick against the pool.
    const recoveredPgSql = createWorkerDb(pool);
    const recoveredHeartbeat = new LeaseHeartbeat({
      leaseRedis,
      pgSql: recoveredPgSql,
      sessionOwner,
      workerId,
      env: ENV,
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    });
    leases.forEach((lease) => recoveredHeartbeat.add(lease));
    await recoveredHeartbeat.tick();
    expect(recoveredHeartbeat.isClaimingAllowed()).toBe(true);
  }, 30_000);
});
