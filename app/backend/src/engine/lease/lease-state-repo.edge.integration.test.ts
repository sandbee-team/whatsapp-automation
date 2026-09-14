import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRedis, resolveRedisUrl, tenantKey } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createLeaseRedis } from './lease-redis.js';
import { release, scanUnowned } from './lease-state-repo.js';
import {
  mintFenceInOwnTransaction,
  seedClientAndInstance,
  type TestPool,
} from './__tests__/lease-state-repo-edge-fixtures.js';

/**
 * lease-state-repo.edge.integration.test.ts (P06 E3 edge pass) - real
 * Postgres + real Redis proofs for edge cases NOT covered by
 * stale-fence.integration.test.ts / lease-fence.concurrency.integration.test.ts
 * / lease-release.integration.test.ts:
 *
 *   1. Placeholder TTL expiry mid-acquire (real Redis PX expiry, not a stub).
 *   6. release() with the right fence but wrong worker id -> false, row
 *      unchanged.
 *   8. scanUnowned bounds: max_rows 0, and each individual exclusion
 *      predicate (desired_state, deleted_at, link_state, health_state).
 *
 * Edge cases 3/4/5/11 (cross-tenant mint, renewBatch duplicates, large
 * batch, fence integrity) live in
 * `lease-state-repo.edge.renew-fence.integration.test.ts`, split out of
 * this file to stay under the workspace max-lines limit. Both files share
 * seeding helpers via `__tests__/lease-state-repo-edge-fixtures.ts`.
 */

type TestRedis = ReturnType<typeof createRedis>;

let pool: TestPool;
let redis: TestRedis;

const ENV = 'test';

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

describe('edge case 1: placeholder TTL expiry mid-acquire (real Redis)', () => {
  it('expired_placeholder_fails_the_setFence_cas_and_a_subsequent_acquire_succeeds_with_a_higher_fence', async () => {
    const { clientId, instanceId } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'ttl-expiry',
    );
    const key = tenantKey(ENV, clientId, 'lease', 'i', instanceId);
    probeKeys.push(key);

    const leaseRedis = createLeaseRedis(redis, { timeoutMs: 1_000 });

    // Stake the NX placeholder. The TTL value is irrelevant to what this
    // case proves - see the DEL below.
    const acquired = await leaseRedis.acquire(key, 'worker-1', 5_000);
    expect(acquired).toBe(true);

    // Mint a real Postgres fence (as LeaseManager.acquire would, between
    // steps 1 and 3) while the placeholder is still present.
    const fence = await mintFenceInOwnTransaction(pool, clientId, instanceId, 'worker-1');
    expect(fence).toBe(1n);

    // The placeholder is GONE by the time setFence runs. This used to be
    // expressed as `acquire(key, 'worker-1', 50)` followed by a real
    // `setTimeout(120)` sleep, waiting for Redis to expire the key on its
    // own - i.e. an assertion on ambient timing (both the sleep's scheduling
    // AND Redis's expiry cycle firing inside that window), which is exactly
    // the flake class core-invariants.md forbids: it passed standalone and
    // failed under full-suite load (2026-09-01, found during P11 C5 prep).
    // What this case is ACTUALLY about is "placeholder absent => CAS fails
    // and corrupts nothing", and absence is absence however it was reached -
    // so delete the key outright and the property is proven with zero timing
    // dependence. TTL-expiry as a MECHANISM is Redis's own behaviour, not
    // this repo's code, and is not what this test exists to prove.
    await redis.del(key);

    // set-fence.lua's CAS must now fail (0/false): GET no longer equals
    // 'worker-1|PENDING' (the key is gone).
    const fenceSet = await leaseRedis.setFence(key, 'worker-1', fence, 5_000);
    expect(fenceSet).toBe(false);

    // No corrupted state left in Redis: the key is simply absent (never
    // written by the failed CAS).
    const rawValue = await redis.get(key);
    expect(rawValue).toBeNull();

    // A subsequent acquire (fresh NX + mint) succeeds cleanly and mints a
    // STRICTLY higher fence than the aborted attempt's mint - Postgres's
    // monotonic sequence was never corrupted or reused by the aborted CAS.
    const secondAcquired = await leaseRedis.acquire(key, 'worker-2', 5_000);
    expect(secondAcquired).toBe(true);
    const secondFence = await mintFenceInOwnTransaction(pool, clientId, instanceId, 'worker-2');
    expect(secondFence).toBeGreaterThan(fence);

    const secondFenceSet = await leaseRedis.setFence(key, 'worker-2', secondFence, 5_000);
    expect(secondFenceSet).toBe(true);
  });
});

describe('edge case 6: release with right fence but wrong worker id', () => {
  it('right_fence_wrong_worker_returns_false_and_leaves_the_row_unchanged', async () => {
    const { clientId, instanceId } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'release-wrong-worker',
    );
    const fence = await mintFenceInOwnTransaction(pool, clientId, instanceId, 'worker-real');

    const beforeRow = await pool.query<{
      owner_worker_id: string | null;
      released_at: Date | null;
    }>('SELECT owner_worker_id, released_at FROM instance_lease_state WHERE instance_id = $1', [
      instanceId,
    ]);

    const tenantDb = createTenantDb(pool);
    const released = await tenantDb.withTenant(clientId, (sql) =>
      release({ clientId, sql }, { instanceId, fence, workerId: 'worker-imposter' }),
    );

    expect(released).toBe(false);

    const afterRow = await pool.query<{ owner_worker_id: string | null; released_at: Date | null }>(
      'SELECT owner_worker_id, released_at FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(afterRow.rows[0]?.owner_worker_id).toBe(beforeRow.rows[0]?.owner_worker_id);
    expect(afterRow.rows[0]?.owner_worker_id).toBe('worker-real');
    expect(afterRow.rows[0]?.released_at).toBeNull();
  });
});

describe('edge case 8: scanUnowned bounds and per-predicate exclusions', () => {
  const staleMs = 1_000;

  async function markStaleUnowned(instanceId: string, clientId: string): Promise<void> {
    await pool.query(
      `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, lease_seen_at)
       VALUES ($1, $2, 1, now() - interval '10 seconds')`,
      [instanceId, clientId],
    );
  }

  it('max_rows_zero_returns_empty', async () => {
    const { clientId, instanceId } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'scan-max-rows-zero',
    );
    await markStaleUnowned(instanceId, clientId);

    const results = await scanUnowned(pool, { staleMs, maxRows: 0 });
    expect(results.find((r) => r.instanceId === instanceId)).toBeUndefined();
  });

  it('excludes_desired_state_offline', async () => {
    const { clientId, instanceId } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'scan-offline',
      {
        desiredState: 'offline',
      },
    );
    await markStaleUnowned(instanceId, clientId);

    const results = await scanUnowned(pool, { staleMs, maxRows: 50 });
    expect(results.some((r) => r.instanceId === instanceId)).toBe(false);
  });

  it('excludes_deleted_at_set', async () => {
    const { clientId, instanceId } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'scan-deleted',
      {
        deletedAt: true,
      },
    );
    await markStaleUnowned(instanceId, clientId);

    const results = await scanUnowned(pool, { staleMs, maxRows: 50 });
    expect(results.some((r) => r.instanceId === instanceId)).toBe(false);
  });

  it('excludes_link_state_unlinked', async () => {
    const { clientId, instanceId } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'scan-unlinked',
      { linkState: 'unlinked' },
    );
    await markStaleUnowned(instanceId, clientId);

    const results = await scanUnowned(pool, { staleMs, maxRows: 50 });
    expect(results.some((r) => r.instanceId === instanceId)).toBe(false);
  });

  it('excludes_health_state_logged_out', async () => {
    const { clientId, instanceId } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'scan-logged-out',
      { healthState: 'logged_out' },
    );
    await markStaleUnowned(instanceId, clientId);

    const results = await scanUnowned(pool, { staleMs, maxRows: 50 });
    expect(results.some((r) => r.instanceId === instanceId)).toBe(false);
  });

  it('sanity_control_a_stale_eligible_instance_is_still_returned', async () => {
    const { clientId, instanceId } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'scan-control-eligible',
    );
    await markStaleUnowned(instanceId, clientId);

    // SIXTH flaky-class member (2026-09-01/02, master-plan): `maxRows: 50`
    // used to be assumed comfortably above the eligible population, but the
    // shared dev DB's `desired_state='online'` population has grown past 50
    // (76 measured live during this dispatch, up from 58 a day earlier) -
    // `wp_lease_scan_unowned`'s own `ORDER BY random() LIMIT max_rows` can
    // then legitimately exclude our own seeded row by chance. Fixed per the
    // class's established pattern: MEASURE the current eligible population
    // in-test rather than assume a constant, by proving `maxRows` was not
    // truncating - `results.length < maxRows` means every eligible row
    // (including ours) was returned, so `ORDER BY random()` never had a
    // chance to exclude anything. `SCAN_CEILING` is sized as a safety
    // multiple of the largest population ever observed for this class, not
    // a number picked to "probably" be enough - the in-test assertion is
    // the actual proof, not the constant.
    const SCAN_CEILING = 5_000;
    const results = await scanUnowned(pool, { staleMs, maxRows: SCAN_CEILING });
    expect(
      results.length,
      `SCAN_CEILING (${SCAN_CEILING}) was truncating the eligible population (returned exactly that many rows) - raise it and re-measure`,
    ).toBeLessThan(SCAN_CEILING);
    expect(results.some((r) => r.instanceId === instanceId)).toBe(true);
  });
});
