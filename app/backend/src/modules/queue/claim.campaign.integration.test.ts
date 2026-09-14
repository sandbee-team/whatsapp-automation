import { randomUUID } from 'node:crypto';
import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { claimOne } from './index.js';
import {
  DEFAULT_CLAIM_INPUT,
  cleanupProbeClients,
  ctxFor,
  getJob,
  seedCampaign,
  seedJob,
  seedTenant,
  type TestPool,
} from './__tests__/claim-test-helpers.js';

/**
 * claim.campaign.integration.test.ts (P03 close, split from
 * `claim.integration.test.ts` for file-size, protocol C2) - finding 6, P03
 * close: the fail-closed campaign predicate had zero coverage. Every
 * negative case below asserts the job stays 'queued', never merely "0 rows
 * returned" (pause-preserves-work rule); the two positive controls
 * (`running`/`expanding`) prove the allow-list itself, not just its
 * negative space.
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

describe('claimOne campaign predicate (running/expanding allow-list)', () => {
  it('campaign_not_running_yields_zero_claims', async () => {
    for (const status of ['paused', 'draft', 'cancelled']) {
      const { clientId, instanceId } = await seedTenant(pool, probeClientIds);
      const campaignId = await seedCampaign(pool, clientId, status, instanceId);
      const jobId = await seedJob(pool, { clientId, instanceId, campaignId });

      const claimed = await claimOne(ctxFor(clientId, pool), {
        instanceId,
        ...DEFAULT_CLAIM_INPUT,
      });

      expect(claimed, `status=${status}`).toBeUndefined();
      const job = await getJob(pool, jobId);
      expect(job.status, `status=${status}`).toBe('queued');
    }
  });

  it('dangling_campaign_id_yields_zero_claims', async () => {
    // No campaigns row at all for this id - the claim's LEFT JOIN must
    // fail-closed, not treat "unknown campaign" as "no campaign".
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds);
    const jobId = await seedJob(pool, { clientId, instanceId, campaignId: randomUUID() });

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed).toBeUndefined();
    const job = await getJob(pool, jobId);
    expect(job.status).toBe('queued');
  });

  it('a_job_referencing_another_tenants_running_campaign_yields_zero_claims', async () => {
    // Pins the `cp.client_id = j.client_id` join qualifier in
    // db/queries/claim-jobs.sql: message_jobs.campaign_id has no FK, so this
    // insert succeeds even though the campaign belongs to a different
    // tenant. Without the tenant-qualified join, a RUNNING campaign owned by
    // ANY tenant would satisfy the allow-list predicate.
    const tenantA = await seedTenant(pool, probeClientIds);
    const tenantB = await seedTenant(pool, probeClientIds);
    const tenantBCampaignId = await seedCampaign(
      pool,
      tenantB.clientId,
      'running',
      tenantB.instanceId,
    );
    const jobId = await seedJob(pool, {
      clientId: tenantA.clientId,
      instanceId: tenantA.instanceId,
      campaignId: tenantBCampaignId,
    });

    const claimed = await claimOne(ctxFor(tenantA.clientId, pool), {
      instanceId: tenantA.instanceId,
      ...DEFAULT_CLAIM_INPUT,
    });

    expect(claimed).toBeUndefined();
    const job = await getJob(pool, jobId);
    expect(job.status).toBe('queued');
  });

  it('campaign_running_allows_claim', async () => {
    // Positive control for the three negative cases above.
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds);
    const campaignId = await seedCampaign(pool, clientId, 'running', instanceId);
    const jobId = await seedJob(pool, { clientId, instanceId, campaignId });

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed?.id).toBe(jobId);
    expect(claimed?.campaignId).toBe(campaignId);
    const job = await getJob(pool, jobId);
    expect(job.status).toBe('processing');
  });

  it('campaign_expanding_allows_claim', async () => {
    // Sibling positive control - 'expanding' is the second allow-listed
    // campaign status alongside 'running' (db/queries/claim-jobs.sql's
    // `cp.status IN ('running','expanding')` predicate).
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds);
    const campaignId = await seedCampaign(pool, clientId, 'expanding', instanceId);
    const jobId = await seedJob(pool, { clientId, instanceId, campaignId });

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed?.id).toBe(jobId);
    expect(claimed?.campaignId).toBe(campaignId);
    const job = await getJob(pool, jobId);
    expect(job.status).toBe('processing');
  });
});
