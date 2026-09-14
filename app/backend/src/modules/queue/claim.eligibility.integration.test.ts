import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { claimOne } from './index.js';
import {
  DEFAULT_CLAIM_INPUT,
  cleanupProbeClients,
  ctxFor,
  getJob,
  seedJob,
  seedTenant,
  type TestPool,
} from './__tests__/claim-test-helpers.js';

/**
 * claim.eligibility.integration.test.ts (P03 close, split from
 * `claim.integration.test.ts` for file-size, protocol C2) - real-Postgres
 * proofs for `claimOne`'s per-tenant/per-instance eligibility predicates:
 * fence, health state, session epoch, client status, wallet presence/state,
 * soft-deleted instance, balance, scheduling window, cross-tenant isolation,
 * and ordering (next_attempt_at then band). Every zero-claim case asserts
 * row counts/statuses, not merely "0 rows returned" (pause-preserves-work
 * rule).
 */

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
  await cleanupProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('claimOne tenant/instance eligibility predicates', () => {
  it('claim_does_not_increment_attempts', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds);
    const jobId = await seedJob(pool, { clientId, instanceId });

    const before = await getJob(pool, jobId);
    expect(before.attempts).toBe(0);

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed?.attempts).toBe(0);
    const after = await getJob(pool, jobId);
    expect(after.attempts).toBe(0);
  });

  it('stale_fence_yields_zero_claims', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds, { fence: 5 });
    const jobId = await seedJob(pool, { clientId, instanceId });

    const claimed = await claimOne(ctxFor(clientId, pool), {
      instanceId,
      ...DEFAULT_CLAIM_INPUT,
      fence: 1,
    });

    expect(claimed).toBeUndefined();
    const job = await getJob(pool, jobId);
    expect(job.status).toBe('queued');
  });

  it('non_connected_health_state_yields_zero_claims_and_preserves_every_job', async () => {
    for (const healthState of ['degraded', 'paused', 'logged_out', 'never_linked']) {
      const { clientId, instanceId } = await seedTenant(pool, probeClientIds, { healthState });
      const jobId = await seedJob(pool, { clientId, instanceId });

      const claimed = await claimOne(ctxFor(clientId, pool), {
        instanceId,
        ...DEFAULT_CLAIM_INPUT,
      });

      expect(claimed, `healthState=${healthState}`).toBeUndefined();
      const job = await getJob(pool, jobId);
      expect(job.status, `healthState=${healthState}`).toBe('queued');
    }
  });

  it('session_epoch_mismatch_yields_zero_claims', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds, { sessionEpoch: 0 });
    const jobId = await seedJob(pool, { clientId, instanceId, sessionEpoch: 1 });

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed).toBeUndefined();
    const job = await getJob(pool, jobId);
    expect(job.status).toBe('queued');
  });

  it('suspended_client_yields_zero_claims', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds, {
      clientStatus: 'suspended',
    });
    const jobId = await seedJob(pool, { clientId, instanceId });

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed).toBeUndefined();
    const job = await getJob(pool, jobId);
    expect(job.status).toBe('queued');
  });

  it('missing_wallet_row_yields_zero_claims', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds, { skipWallet: true });
    const jobId = await seedJob(pool, { clientId, instanceId });

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed).toBeUndefined();
    const job = await getJob(pool, jobId);
    expect(job.status).toBe('queued');
  });

  it('wallet_empty_stops_claims_and_leaves_every_job_queued', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds, {
      walletState: 'empty',
    });
    const jobId = await seedJob(pool, { clientId, instanceId });

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed).toBeUndefined();
    const job = await getJob(pool, jobId);
    expect(job.status).toBe('queued');

    const instance = await pool.query<{ health_state: string }>(
      'SELECT health_state FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(instance.rows[0]?.health_state).toBe('connected');
  });

  it('claim_orders_by_next_attempt_at_then_id_within_a_band', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds);
    const now = Date.now();

    const otherBandOlder = await seedJob(pool, {
      clientId,
      instanceId,
      band: 20,
      nextAttemptAt: new Date(now - 120_000),
    });
    const requestedBandNewer = await seedJob(pool, {
      clientId,
      instanceId,
      band: DEFAULT_CLAIM_INPUT.band,
      nextAttemptAt: new Date(now - 30_000),
    });
    const requestedBandOldest = await seedJob(pool, {
      clientId,
      instanceId,
      band: DEFAULT_CLAIM_INPUT.band,
      nextAttemptAt: new Date(now - 90_000),
    });

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed?.id).toBe(requestedBandOldest);
    expect(claimed?.id).not.toBe(requestedBandNewer);
    expect(claimed?.id).not.toBe(otherBandOlder);

    const otherBandJob = await getJob(pool, otherBandOlder);
    expect(otherBandJob.status).toBe('queued');
  });

  it('another_tenants_job_is_never_returned', async () => {
    // P03 close, C1: this used to claim tenant A's OWN job against A's OWN
    // instance and merely assert the id matched - that would pass even
    // without the client_id predicate at all. The real cross-tenant probe is
    // A's ctx paired with B's instanceId: the client_id predicate alone must
    // reject it, independent of any instance-side join.
    const tenantA = await seedTenant(pool, probeClientIds, { instanceLabel: 'shared-label' });
    const tenantB = await seedTenant(pool, probeClientIds, { instanceLabel: 'shared-label' });

    const jobB = await seedJob(pool, {
      clientId: tenantB.clientId,
      instanceId: tenantB.instanceId,
    });

    const claimed = await claimOne(ctxFor(tenantA.clientId, pool), {
      instanceId: tenantB.instanceId,
      ...DEFAULT_CLAIM_INPUT,
    });

    expect(claimed).toBeUndefined();

    // pause-preserves-work rule - tenant B's job must still be there,
    // untouched, not merely "not returned".
    const tenantBJob = await getJob(pool, jobB);
    expect(tenantBJob.status).toBe('queued');
  });

  it('soft_deleted_instance_yields_zero_claims', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds);
    const jobId = await seedJob(pool, { clientId, instanceId });
    await pool.query('UPDATE whatsapp_instances SET deleted_at = now() WHERE id = $1', [
      instanceId,
    ]);

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed).toBeUndefined();
    const job = await getJob(pool, jobId);
    expect(job.status).toBe('queued');
  });

  it('insufficient_balance_yields_zero_claims', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds, {
      balanceMinor: 5,
      maxRateMinor: 100,
    });
    const jobId = await seedJob(pool, { clientId, instanceId });

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed).toBeUndefined();
    const job = await getJob(pool, jobId);
    expect(job.status).toBe('queued');
  });

  it('future_scheduled_at_yields_zero_claims', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds);
    const jobId = await seedJob(pool, {
      clientId,
      instanceId,
      scheduledAt: new Date(Date.now() + 3_600_000),
      nextAttemptAt: new Date(Date.now() - 60_000),
    });

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed).toBeUndefined();
    const job = await getJob(pool, jobId);
    expect(job.status).toBe('queued');
  });

  it('future_next_attempt_at_yields_zero_claims', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds);
    const jobId = await seedJob(pool, {
      clientId,
      instanceId,
      nextAttemptAt: new Date(Date.now() + 3_600_000),
    });

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed).toBeUndefined();
    const job = await getJob(pool, jobId);
    expect(job.status).toBe('queued');
  });
});
