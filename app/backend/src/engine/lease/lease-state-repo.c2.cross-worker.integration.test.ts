import { createPool, createTenantDb, createWorkerDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRedis, resolveRedisUrl, tenantKey } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createLeaseRedis } from './lease-redis.js';
import { LeaseManager, type SessionLease } from './lease-manager.js';
import { renewBatch } from './lease-state-repo.js';
import type { SessionOwner } from './session-owner.port.js';
import {
  mintFenceInOwnTransaction,
  seedClientAndInstance,
  type TestPool,
  type TestRedis,
} from './__tests__/lease-state-repo-c2-fixtures.js';

/**
 * lease-state-repo.c2.cross-worker.integration.test.ts (P06 C2 all-cases
 * pass) - real Postgres (+ real Redis for probe 7) proofs, split out of
 * lease-state-repo.c2.integration.test.ts (which keeps probes 1-2) to stay
 * under the workspace max-lines limit:
 *
 *   6. Two-tenant / cross-worker interference on one renew batch: only the
 *      calling worker's own rows renew; a different worker's row untouched.
 *   7. Retry storm on acquire: ~20 rapid-fire attempts from 3 workers
 *      against one held instance - exactly one owner, no fence inflation,
 *      no orphaned PENDING placeholders after the storm settles.
 */

const ENV = 'test';

let pool: TestPool;
let redis: TestRedis;
let workerDb: ReturnType<typeof createWorkerDb>;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  redis = createRedis(resolveRedisUrl());
  workerDb = createWorkerDb(pool);
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

describe('probe 6: two-tenant / cross-worker interference on one renew batch', () => {
  it('a_batch_containing_an_instance_id_owned_by_a_DIFFERENT_worker_only_renews_the_calling_workers_own_rows_the_other_workers_row_is_untouched', async () => {
    // Worker W holds leases for tenant A and tenant B (legit cross-tenant
    // batch by design). The SAME batch also names an instance whose lease
    // is actually owned by a DIFFERENT worker (X) - W has no business
    // renewing X's row. Only W's own two rows must renew; X's row must be
    // completely untouched (not renewed, not fenced/cleared).
    const { clientId: clientA, instanceId: instanceA } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'tenant-a-w',
    );
    const { clientId: clientB, instanceId: instanceB } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'tenant-b-w',
    );
    const { clientId: clientX, instanceId: instanceXOwnedByOther } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'tenant-x-other-worker',
    );

    const fenceA = await mintFenceInOwnTransaction(pool, clientA, instanceA, 'worker-w');
    const fenceB = await mintFenceInOwnTransaction(pool, clientB, instanceB, 'worker-w');
    const fenceX = await mintFenceInOwnTransaction(
      pool,
      clientX,
      instanceXOwnedByOther,
      'worker-x',
    );

    const beforeXSeenAt = await pool.query<{ lease_seen_at: Date; owner_worker_id: string }>(
      'SELECT lease_seen_at, owner_worker_id FROM instance_lease_state WHERE instance_id = $1',
      [instanceXOwnedByOther],
    );
    expect(beforeXSeenAt.rows[0]?.owner_worker_id).toBe('worker-x');

    await new Promise((resolve) => setTimeout(resolve, 20));

    // Worker W's batch names all three instances - including X's, which W
    // does not own. Note: W supplies X's REAL current fence here (the
    // worst case - even with the correct fence, ownership must still gate
    // the renew, since the SQL predicate is owner_worker_id = $worker, not
    // fence-only).
    const result = await renewBatch(workerDb, {
      workerId: 'worker-w',
      leases: [
        { instanceId: instanceA, fence: fenceA },
        { instanceId: instanceB, fence: fenceB },
        { instanceId: instanceXOwnedByOther, fence: fenceX },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only W's own two rows renewed.
      expect(result.renewed.has(instanceA)).toBe(true);
      expect(result.renewed.has(instanceB)).toBe(true);
      // X's row, owned by a different worker, did NOT renew even though W
      // supplied its correct fence and instance id in the same batch.
      expect(result.renewed.has(instanceXOwnedByOther)).toBe(false);
      expect(result.renewed.size).toBe(2);
    }

    // X's row is byte-for-byte untouched: same lease_seen_at, same owner,
    // not fenced (owner_worker_id still worker-x, not cleared/NULLed).
    const afterXSeenAt = await pool.query<{ lease_seen_at: Date; owner_worker_id: string }>(
      'SELECT lease_seen_at, owner_worker_id FROM instance_lease_state WHERE instance_id = $1',
      [instanceXOwnedByOther],
    );
    expect(afterXSeenAt.rows[0]?.owner_worker_id).toBe('worker-x');
    expect(afterXSeenAt.rows[0]?.lease_seen_at.getTime()).toBe(
      beforeXSeenAt.rows[0]?.lease_seen_at.getTime(),
    );
  });
});

describe('probe 7: retry storm on acquire (~20 rapid-fire attempts, 3 workers, 1 instance)', () => {
  const STORM_TIMING = {
    leaseTtlMs: 5_000,
    heartbeatMs: 500,
    takeoverGraceMs: 10, // compressed - grace still runs but resolves fast
    watchdogMs: 5_000,
    sendTimeoutMs: 1000,
    claimExpiryMs: 2000,
    reaperGraceMs: 500,
    reconcileWindowMs: 5000,
    redisCommandTimeoutMs: 2000,
  } as const;

  function makeSessionOwner(): SessionOwner {
    return { onFenceLost: async () => undefined, close: async () => undefined };
  }

  it('twenty_rapid_fire_acquire_attempts_from_three_workers_against_one_instance_yield_exactly_one_owner_throughout_no_fence_inflation_no_orphaned_placeholders', async () => {
    const { clientId, instanceId } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'retry-storm',
    );
    const key = tenantKey(ENV, clientId, 'lease', 'i', instanceId);
    probeKeys.push(key);

    const leaseRedis = createLeaseRedis(redis, { timeoutMs: STORM_TIMING.redisCommandTimeoutMs });
    const tenantDb = createTenantDb(pool);

    const workerIds = ['storm-worker-1', 'storm-worker-2', 'storm-worker-3'];
    const ATTEMPTS_PER_WORKER = 7; // 3 * 7 = 21, "~20 rapid-fire attempts"

    function makeManager(workerId: string): LeaseManager {
      return new LeaseManager({
        leaseRedis,
        tenantDb,
        sessionOwner: makeSessionOwner(),
        timing: STORM_TIMING as unknown as typeof import('@wp/domain').TIMING,
        // Real sleep, but the grace is compressed to 10ms so the whole
        // storm still runs fast and deterministically bounded.
        workerId,
        env: ENV,
      });
    }

    // Compressed, rapid-fire timing: fire every attempt from every worker
    // essentially at once (Promise.all per "wave"), 7 waves.
    const allResults: (SessionLease | null)[] = [];
    for (let wave = 0; wave < ATTEMPTS_PER_WORKER; wave += 1) {
      const waveResults = await Promise.all(
        workerIds.map((workerId) => makeManager(workerId).acquire({ instanceId, clientId })),
      );
      allResults.push(...waveResults);
    }

    // Exactly-one-owner-at-a-time proof: for every wave, at most one
    // acquire in that wave succeeded (NX enforces this per wave - a wave is
    // 3 truly concurrent attempts).
    for (let wave = 0; wave < ATTEMPTS_PER_WORKER; wave += 1) {
      const waveSlice = allResults.slice(wave * workerIds.length, (wave + 1) * workerIds.length);
      const winners = waveSlice.filter((r) => r !== null);
      expect(winners.length).toBeLessThanOrEqual(1);
    }

    // No fence inflation beyond the successful mints: the number of
    // successful acquires across the whole storm must equal the FINAL
    // current_fence value (mint bumps by exactly 1 per successful mint,
    // and every successful acquire = one successful mint by construction -
    // no acquire attempt mints without eventually returning a lease or
    // safely aborting).
    const successfulAcquires = allResults.filter((r) => r !== null);
    const finalFenceRow = await pool.query<{ current_fence: string }>(
      'SELECT current_fence FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(finalFenceRow.rows[0]?.current_fence).toBe(String(successfulAcquires.length));

    // No orphaned PENDING placeholders left after the storm settles: the
    // Redis key either holds the last winner's real "worker|fence" value or
    // has expired via its own TTL - it must never be stuck at a
    // "worker|PENDING" sentinel (which would mean a mint-then-CAS sequence
    // left a placeholder behind without ever being cleaned up or replaced).
    const rawValue = await redis.get(key);
    if (rawValue !== null) {
      expect(rawValue).not.toMatch(/\|PENDING$/);
    }

    // Sanity: at least one acquire in the storm succeeded (the very first
    // wave's first attempt, at minimum, must win against an unheld
    // instance).
    expect(successfulAcquires.length).toBeGreaterThan(0);
  }, 30_000);
});
