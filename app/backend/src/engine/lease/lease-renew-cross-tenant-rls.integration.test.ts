import { randomUUID } from 'node:crypto';
import { createPool, createWorkerDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { mintFence, renewBatch, type MintFenceCtx } from './lease-state-repo.js';
import { createWorkerDbAsRole } from './test-support/worker-as-role.js';

/**
 * lease-renew-cross-tenant-rls.integration.test.ts (C1 fix, load-bearing) -
 * the ONE proof the C1 reviewer's findings 1+2 demand: `renewBatch`, run
 * through the real `withWorker` runner UNDER `SET LOCAL ROLE wp_app` (the
 * dev pool's own connection role is superuser/BYPASSRLS - an un-roled probe
 * would be vacuous, same reasoning `wp-app-role.ts`'s header gives), with
 * ONLY `app.worker_id` set (no `app.client_id` at all - production
 * heartbeat shape), spanning TWO different tenants' instances in ONE
 * statement, must renew BOTH rows.
 *
 * This test is written to fail RED against the pre-0019 tree (0018's
 * `lease_owner_renew` FOR UPDATE-only policy plus the old `sql.query('SELECT
 * set_config...')`-as-a-separate-call `renewBatch` shape): under `wp_app`
 * with only `app.worker_id` set, Postgres has no SELECT/ALL policy visible
 * to the UPDATE's WHERE/RETURNING clause, so the statement matches zero
 * rows regardless of ownership - `renewed` comes back empty for both
 * instances. Verified live against the dev DB before migration 0019 existed
 * (see the C1 fix report) - this test is that same proof, checked in.
 */

type TestPool = ReturnType<typeof createPool>;

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
});

afterAll(async () => {
  await pool.end();
});

let probeClientIds: string[] = [];

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    probeClientIds = [];
  }
});

async function seedClientAndInstance(
  label: string,
): Promise<{ clientId: string; instanceId: string }> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Lease RLS Renew Probe Client',
    `lease-rls-renew-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch, desired_state, link_state)
     VALUES ($1, $2, $3, 'connected', 0, 'online', 'linked')`,
    [instanceId, clientId, label],
  );

  probeClientIds.push(clientId);
  return { clientId, instanceId };
}

/** Mints a fence for `(clientId, instanceId)` as `workerId`, in its own real transaction (mintFence needs both its statements to share one). */
async function mintFenceInOwnTransaction(
  clientId: string,
  instanceId: string,
  workerId: string,
): Promise<bigint> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx: MintFenceCtx = { clientId, sql: client };
    const result = await mintFence(ctx, { instanceId, workerId });
    await client.query('COMMIT');
    return result.fence;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

describe('batched renew spans two tenants in one statement under wp_app', () => {
  it('batched_renew_spans_two_tenants_in_one_statement_under_wp_app', async () => {
    const workerId = 'worker-cross-tenant-rls';

    const { clientId: clientA, instanceId: instanceA } =
      await seedClientAndInstance('cross-tenant-a');
    const { clientId: clientB, instanceId: instanceB } =
      await seedClientAndInstance('cross-tenant-b');

    const fenceA = await mintFenceInOwnTransaction(clientA, instanceA, workerId);
    const fenceB = await mintFenceInOwnTransaction(clientB, instanceB, workerId);

    const beforeRows = await pool.query<{ instance_id: string; lease_seen_at: Date }>(
      'SELECT instance_id, lease_seen_at FROM instance_lease_state WHERE instance_id = ANY($1)',
      [[instanceA, instanceB]],
    );
    const beforeByInstance = new Map(
      beforeRows.rows.map((row) => [row.instance_id, row.lease_seen_at]),
    );

    // A small real delay so lease_seen_at's advance is unambiguously
    // detectable (Postgres now() granularity).
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Real `withWorker` runner, but under `SET LOCAL ROLE wp_app` (the
    // dev/test pool's own role is superuser/BYPASSRLS - RLS is not enforced
    // for it regardless of FORCE ROW LEVEL SECURITY, so this probe would be
    // vacuous without the role switch).
    const workerDbAsWpApp = createWorkerDbAsRole(pool, 'wp_app');

    const result = await renewBatch(workerDbAsWpApp, {
      workerId,
      leases: [
        { instanceId: instanceA, fence: fenceA },
        { instanceId: instanceB, fence: fenceB },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.renewed.has(instanceA)).toBe(true);
      expect(result.renewed.has(instanceB)).toBe(true);
      expect(result.renewed.size).toBe(2);
    }

    const afterRows = await pool.query<{ instance_id: string; lease_seen_at: Date }>(
      'SELECT instance_id, lease_seen_at FROM instance_lease_state WHERE instance_id = ANY($1)',
      [[instanceA, instanceB]],
    );
    for (const row of afterRows.rows) {
      const before = beforeByInstance.get(row.instance_id);
      expect(before).toBeDefined();
      expect(row.lease_seen_at.getTime()).toBeGreaterThan((before as Date).getTime());
    }

    // Sanity: production shape actually used here has NO app.client_id set
    // anywhere in this test - the cross-tenant renew must not depend on it.
  });

  it('sanity_control_createWorkerDb_without_the_wp_app_role_also_renews_both_as_a_bypassrls_superuser', async () => {
    // Non-vacuous control: proves the seeding/mint/renew wiring itself is
    // correct independent of RLS - run as the pool's own (superuser)
    // connection role via the production createWorkerDb, no role switch.
    const workerId = 'worker-cross-tenant-control';

    const { clientId: clientA, instanceId: instanceA } = await seedClientAndInstance('control-a');
    const { clientId: clientB, instanceId: instanceB } = await seedClientAndInstance('control-b');

    const fenceA = await mintFenceInOwnTransaction(clientA, instanceA, workerId);
    const fenceB = await mintFenceInOwnTransaction(clientB, instanceB, workerId);

    const workerDb = createWorkerDb(pool);
    const result = await renewBatch(workerDb, {
      workerId,
      leases: [
        { instanceId: instanceA, fence: fenceA },
        { instanceId: instanceB, fence: fenceB },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.renewed.size).toBe(2);
    }
  });
});
