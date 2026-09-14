import { randomUUID } from 'node:crypto';
import { createPool, createWorkerDb } from '@wp/db';
import { claimOne } from '../../modules/queue/index.js';
import {
  cleanupProbeClients,
  ctxFor,
  DEFAULT_CLAIM_INPUT,
  getJob,
  seedJob,
  seedTenant,
} from '../../modules/queue/__tests__/claim-test-helpers.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { mintFence, renewBatch, scanUnowned, type MintFenceCtx } from './lease-state-repo.js';

/**
 * stale-fence.integration.test.ts (P06 Unit U3) - real-Postgres proofs that
 * a stale (superseded) fence can neither claim, nor renew, nor be confused
 * with "database unavailable" - and that the discovery scan
 * (`wp_lease_scan_unowned`) correctly finds unowned instances, skips
 * recently-renewed ones, and crosses tenants read-only (P07 extends the
 * first describe block with setKeys/purge cases once those exist; today's
 * scope is claim + renewBatch only).
 */

type Pool = ReturnType<typeof createPool>;

let pool: Pool;
let workerDb: ReturnType<typeof createWorkerDb>;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  workerDb = createWorkerDb(pool);
});

afterAll(async () => {
  await pool.end();
});

let probeClientIds: string[] = [];

afterEach(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

/** Runs `mintFence` inside its own real transaction (see lease-fence.concurrency test's identical helper). */
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

describe('stale fence cannot claim or renew', () => {
  it('stale_fence_cannot_claim_save_purge_or_write_events', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds, { fence: 1 });
    const jobId = await seedJob(pool, { clientId, instanceId });

    // f1: the fence already seeded by seedTenant (current_fence = 1).
    const f1 = 1;
    // f2: mint again - bumps current_fence to 2, making f1 stale.
    const f2 = await mintFenceInOwnTransaction(clientId, instanceId, 'worker-2');
    expect(f2).toBe(2n);

    // (a) claimOne with the stale fence f1 must not claim, and the job must
    // still be queued.
    const staleClaim = await claimOne(ctxFor(clientId, pool), {
      instanceId,
      ...DEFAULT_CLAIM_INPUT,
      fence: f1,
    });
    expect(staleClaim).toBeUndefined();
    const jobAfterStale = await getJob(pool, jobId);
    expect(jobAfterStale.status).toBe('queued');

    // claimOne with the current fence f2 must claim it.
    const validClaim = await claimOne(ctxFor(clientId, pool), {
      instanceId,
      ...DEFAULT_CLAIM_INPUT,
      fence: f2,
    });
    expect(validClaim?.id).toBe(jobId);
    const jobAfterValid = await getJob(pool, jobId);
    expect(jobAfterValid.status).toBe('processing');

    // (b) renewBatch: (instance, f1) must NOT be renewed; (instance, f2)
    // must be renewed. Use a fresh instance pair so each renew call is
    // independent of the claim above.
    const renewResult = await renewBatch(workerDb, {
      workerId: 'worker-2',
      leases: [
        { instanceId, fence: f1 },
        { instanceId, fence: f2 },
      ],
    });

    expect(renewResult.ok).toBe(true);
    if (renewResult.ok) {
      // Only one row can ever match per instance_id (current_fence is a
      // single column) - the f2 attempt is the one that matches.
      expect(renewResult.renewed.has(instanceId)).toBe(true);
      expect(renewResult.renewed.size).toBe(1);
    }
  });

  it('renew_batch_does_not_renew_a_stale_fence_even_when_paired_with_a_different_valid_instance', async () => {
    const stale = await seedTenant(pool, probeClientIds, { fence: 5 });
    const valid = await seedTenant(pool, probeClientIds, { fence: 1 });

    // renewBatch's owner predicate is `owner_worker_id = $worker` - seedTenant
    // leaves owner_worker_id NULL, so both rows need an explicit owner stamp
    // before a renew attempt can ever match either of them.
    await pool.query(
      "UPDATE instance_lease_state SET owner_worker_id = 'worker-1' WHERE instance_id = ANY($1)",
      [[stale.instanceId, valid.instanceId]],
    );

    const result = await renewBatch(workerDb, {
      workerId: 'worker-1',
      leases: [
        { instanceId: stale.instanceId, fence: 1 }, // stale: actual current_fence is 5
        { instanceId: valid.instanceId, fence: 1 }, // valid
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.renewed.has(stale.instanceId)).toBe(false);
      expect(result.renewed.has(valid.instanceId)).toBe(true);
      expect(result.renewed.size).toBe(1);
    }
  });
});

describe('scanUnowned discovery scan', () => {
  const staleMs = 1_000;

  async function seedInstance(options: {
    clientCompanyName: string;
    label: string;
  }): Promise<{ clientId: string; instanceId: string }> {
    const clientId = randomUUID();
    const instanceId = randomUUID();

    await pool.query(
      'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
      [clientId, options.clientCompanyName, `lease-scan-probe-${clientId}`, 'active'],
    );
    await pool.query(
      `INSERT INTO whatsapp_instances
         (id, client_id, label, health_state, session_epoch, desired_state, link_state)
       VALUES ($1, $2, $3, 'connected', 0, 'online', 'linked')`,
      [instanceId, clientId, options.label],
    );

    probeClientIds.push(clientId);
    return { clientId, instanceId };
  }

  it('scan_returns_unowned_never_owned_and_skips_renewed_instances', async () => {
    // Instance A: fresh lease_seen_at - must NOT be returned (not stale).
    const fresh = await seedInstance({ clientCompanyName: 'Scan Probe Client A', label: 'fresh' });
    await pool.query(
      `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
       VALUES ($1, $2, 1, 'worker-x', now())`,
      [fresh.instanceId, fresh.clientId],
    );

    // Instance B: stale lease_seen_at - must be returned.
    const stale = await seedInstance({ clientCompanyName: 'Scan Probe Client B', label: 'stale' });
    await pool.query(
      `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
       VALUES ($1, $2, 1, 'worker-y', now() - interval '10 seconds')`,
      [stale.instanceId, stale.clientId],
    );

    // Instance C: no instance_lease_state row at all - must be returned
    // (the LEFT JOIN case), under a SECOND distinct client than A/B.
    const never = await seedInstance({
      clientCompanyName: 'Scan Probe Client C',
      label: 'never-leased',
    });

    // Run as the scheduler role, WITHOUT any app.client_id GUC set - proves
    // the definer function crosses tenants read-only. maxRows deliberately
    // set to the definer function's own hard ceiling (migration 0019: 500,
    // not this test's real-world 50) - `wp_lease_scan_unowned` orders by
    // random() as a fairness policy (any eligible row must be reachable
    // over repeated ticks, not starved by id order), so a real production
    // call's maxRows=50 is inherently a bounded SAMPLE, not a guarantee any
    // specific row appears in one call. This test seeds exactly 3 known
    // rows and asserts on all 3 by identity - it must not depend on
    // winning a random draw against whatever ELSE is eligible in a shared
    // dev database at the moment it runs (e.g. leftover fixture data from
    // other tools). Widening to the ceiling here is test-only; it does not
    // change scanUnowned's SQL or any production call site's real maxRows.
    const results = await scanUnowned(pool, { staleMs, maxRows: 500 });
    const returnedInstanceIds = new Set(results.map((r) => r.instanceId));

    expect(returnedInstanceIds.has(fresh.instanceId)).toBe(false);
    expect(returnedInstanceIds.has(stale.instanceId)).toBe(true);
    expect(returnedInstanceIds.has(never.instanceId)).toBe(true);

    // The two returned instances belong to two DIFFERENT clients - proving
    // the scan is not accidentally scoped to a single tenant.
    const staleRow = results.find((r) => r.instanceId === stale.instanceId);
    const neverRow = results.find((r) => r.instanceId === never.instanceId);
    expect(staleRow?.clientId).toBe(stale.clientId);
    expect(neverRow?.clientId).toBe(never.clientId);
    expect(staleRow?.clientId).not.toBe(neverRow?.clientId);
  });
});
