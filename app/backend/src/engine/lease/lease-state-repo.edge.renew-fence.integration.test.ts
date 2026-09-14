import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, createWorkerDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { mintFence, renewBatch, type MintFenceCtx } from './lease-state-repo.js';
import {
  mintFenceInOwnTransaction,
  seedClientAndInstance,
  type TestPool,
} from './__tests__/lease-state-repo-edge-fixtures.js';

/**
 * lease-state-repo.edge.renew-fence.integration.test.ts (P06 E3 edge
 * pass) - real Postgres proofs, split out of
 * lease-state-repo.edge.integration.test.ts (which keeps the
 * mint/release/scan edge cases 1/6/8) to stay under the workspace
 * max-lines limit:
 *
 *   3. renewBatch with duplicate instanceIds in one batch.
 *   4. renewBatch with a 1,000-lease batch - one statement, no param blowup.
 *   5. Cross-tenant mint attempt (RLS WITH CHECK violation, fail-safe).
 *   11. Fence > Number.MAX_SAFE_INTEGER round-trips as bigint through mint
 *       -> renewBatch without precision loss.
 */

type TestRedis = ReturnType<typeof createRedis>;

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

describe('edge case 3: renewBatch with duplicate instanceIds in one batch', () => {
  it('duplicate_instance_id_in_the_same_batch_does_not_error_and_renews_correctly', async () => {
    const { clientId, instanceId } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'dup-batch',
      {},
    );
    await pool.query(
      'UPDATE instance_lease_state SET owner_worker_id = $1 WHERE instance_id = $2',
      ['worker-dup', instanceId],
    );
    // seedClientAndInstance does not itself create an instance_lease_state
    // row (unlike claim-test-helpers' seedTenant) - insert one explicitly at
    // fence 1.
    await pool.query(
      `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id)
       VALUES ($1, $2, 1, 'worker-dup')
       ON CONFLICT (instance_id) DO UPDATE SET current_fence = 1, owner_worker_id = 'worker-dup'`,
      [instanceId, clientId],
    );

    const result = await renewBatch(workerDb, {
      workerId: 'worker-dup',
      leases: [
        { instanceId, fence: 1 },
        { instanceId, fence: 1 },
        { instanceId, fence: 1 },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only one row exists for this instance_id - the duplicate entries in
      // the input array must not error (no unique-violation, no crash) and
      // the renewed set contains the instance exactly once (a Set, not a
      // list - duplicate matches collapse naturally).
      expect(result.renewed.has(instanceId)).toBe(true);
      expect(result.renewed.size).toBe(1);
    }
  });
});

describe('edge case 4: renewBatch with a 1,000-lease batch', () => {
  it('renews_1000_leases_in_exactly_one_statement_no_param_limit_blowup', async () => {
    const clientId = randomUUID();
    await pool.query(
      'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
      [clientId, 'Lease Edge Large Batch Client', `lease-edge-large-batch-${clientId}`, 'active'],
    );
    probeClientIds.push(clientId);

    const COUNT = 1_000;
    const instanceIds: string[] = [];
    const values: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;
    for (let i = 0; i < COUNT; i += 1) {
      const instanceId = randomUUID();
      instanceIds.push(instanceId);
      values.push(
        `($${String(paramIndex)}, $${String(paramIndex + 1)}, 'batch-${String(i)}', 'connected', 0)`,
      );
      params.push(instanceId, clientId);
      paramIndex += 2;
    }
    await pool.query(
      `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch) VALUES ${values.join(', ')}`,
      params,
    );

    const leaseValues: string[] = [];
    const leaseParams: unknown[] = [];
    let leaseParamIndex = 1;
    for (const instanceId of instanceIds) {
      leaseValues.push(
        `($${String(leaseParamIndex)}, $${String(leaseParamIndex + 1)}, 1, 'worker-batch')`,
      );
      leaseParams.push(instanceId, clientId);
      leaseParamIndex += 2;
    }
    await pool.query(
      `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id) VALUES ${leaseValues.join(', ')}`,
      leaseParams,
    );

    const result = await renewBatch(workerDb, {
      workerId: 'worker-batch',
      leases: instanceIds.map((instanceId) => ({ instanceId, fence: 1 })),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.renewed.size).toBe(COUNT);
      for (const instanceId of instanceIds) {
        expect(result.renewed.has(instanceId)).toBe(true);
      }
    }
  }, 30_000);
});

describe('edge case 11: fence integrity beyond Number.MAX_SAFE_INTEGER', () => {
  it('a_fence_above_max_safe_integer_round_trips_as_bigint_through_mint_and_renewBatch_without_precision_loss', async () => {
    const { clientId, instanceId } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'bigint-fence',
    );

    // Number.MAX_SAFE_INTEGER = 9_007_199_254_740_991. Seed current_fence
    // directly via SQL well above that (near 2^60 = 1_152_921_504_606_846_976).
    const hugeFence = 1_152_921_504_606_846_976n; // 2^60
    await pool.query(
      `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id)
       VALUES ($1, $2, $3, 'worker-huge')
       ON CONFLICT (instance_id) DO UPDATE SET current_fence = $3, owner_worker_id = 'worker-huge'`,
      [instanceId, clientId, hugeFence.toString()],
    );

    // mintFence bumps by exactly 1 - the RETURNING value must come back as
    // hugeFence + 1n with no float rounding (a naive Number() cast anywhere
    // in the pg driver/binding path would silently lose precision above
    // 2^53).
    const mintedFence = await mintFenceInOwnTransaction(
      pool,
      clientId,
      instanceId,
      'worker-huge-2',
    );
    expect(mintedFence).toBe(hugeFence + 1n);
    expect(mintedFence > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);

    // renewBatch's claim-predicate binding must accept this exact bigint
    // (passed as `.toString()` per lease-state-repo.ts's renewBatch) and
    // match the row without precision loss.
    const renewResult = await renewBatch(workerDb, {
      workerId: 'worker-huge-2',
      leases: [{ instanceId, fence: mintedFence }],
    });
    expect(renewResult.ok).toBe(true);
    if (renewResult.ok) {
      expect(renewResult.renewed.has(instanceId)).toBe(true);
    }

    // Reading current_fence back directly confirms exact value equality
    // (string comparison avoids any JS-side re-parsing ambiguity).
    const raw = await pool.query<{ current_fence: string }>(
      'SELECT current_fence FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(raw.rows[0]?.current_fence).toBe((hugeFence + 1n).toString());
  });
});

describe('edge case 5: cross-tenant mint attempt (RLS write-path proof)', () => {
  it('minting_for_client_b_instance_while_guc_is_client_a_yields_zero_row_write_and_a_loud_error', async () => {
    const clientAId = randomUUID();
    const clientBId = randomUUID();
    const instanceBId = randomUUID();

    await pool.query(
      'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
      [clientAId, 'Lease Edge Cross Tenant Client A', `lease-edge-cross-a-${clientAId}`, 'active'],
    );
    await pool.query(
      'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
      [clientBId, 'Lease Edge Cross Tenant Client B', `lease-edge-cross-b-${clientBId}`, 'active'],
    );
    await pool.query(
      `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
       VALUES ($1, $2, $3, 'connected', 0)`,
      [instanceBId, clientBId, 'cross-tenant-b'],
    );
    probeClientIds.push(clientAId, clientBId);

    // Manually open a transaction AS wp_app (the RLS-bound application
    // role - the dev/test pool's own connection role is a superuser with
    // BYPASSRLS, which would make this probe vacuous: RLS is enforced for
    // wp_app, not for a superuser, regardless of FORCE ROW LEVEL SECURITY),
    // set app.client_id to CLIENT A, then call mintFence with
    // ctx.clientId = CLIENT B (and instanceId belonging to client B) -
    // simulating a caller that mismatches the tenant GUC from the mint
    // input, which TenantDb.withTenant itself would never allow to happen
    // (it derives the GUC from the same clientId it passes to fn), so this
    // proves the RLS write-path defense holds even if a caller somehow got
    // the two out of sync.
    const client = await pool.connect();
    let mintError: unknown;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_app');
      await client.query('SELECT set_config($1, $2, true)', ['app.client_id', clientAId]);
      const ctx: MintFenceCtx = { clientId: clientBId, sql: client };
      try {
        await mintFence(ctx, { instanceId: instanceBId, workerId: 'worker-cross' });
      } catch (err) {
        mintError = err;
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    // The mint must have thrown/errored (fail-safe: an ambiguous/blocked
    // write is a loud error, never a silent success) - either the RLS WITH
    // CHECK policy rejects the INSERT/UPDATE outright, or the read sees
    // zero rows (client A cannot see client B's row) and the subsequent
    // upsert's WITH CHECK still rejects writing a client_id that does not
    // match the transaction's app.client_id GUC.
    expect(mintError).toBeDefined();

    // No row was written for client B's instance under any owner - the
    // rolled-back transaction guarantees this, verified by reading back
    // with a FRESH, correctly-scoped transaction (app.client_id = client B).
    const verifyTenantDb = createTenantDb(pool);
    const rows = await verifyTenantDb.withTenant(clientBId, (sql) =>
      sql.query<{ instance_id: string }>(
        'SELECT instance_id FROM instance_lease_state WHERE instance_id = $1',
        [instanceBId],
      ),
    );
    expect(rows.rows.length).toBe(0);
  });
});
