import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createExpansionBudget } from './expansion-budget.js';
import { runExpansionBatch, runExpansionToCompletion } from './expansion.worker.js';
import { cancelBroadcast } from './lifecycle.service.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedExpandingCampaign,
  statementsFor,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { jobRows, noopBookkeeping, tryClaim } from './__tests__/lifecycle-test-support.js';

/**
 * expansion-edge.integration.test.ts (P23 test-engineer hardening pass) -
 * edge cases NOT covered by expansion.integration.test.ts /
 * expansion-drain-demo.integration.test.ts:
 *   - a cancel committed WHILE expansion is mid-flight: the very next claim
 *     sees zero rows regardless of how far expansion had already run.
 *   - a future `scheduled_at` on the campaign keeps every expanded job
 *     unclaimable until that instant (both `next_attempt_at` and
 *     `scheduled_at` gates in claim-jobs.sql).
 *   - two DIFFERENT clients' expansion workers run fully concurrently - the
 *     per-client advisory lock for client A must never block client B.
 *   - a slow (latency-injecting, never down) tenantDb wrapper around
 *     expansion must not change the outcome (row counts), only its own
 *     wall-clock cost.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];
const unlimitedBudget = () =>
  createExpansionBudget({
    ratePerSecond: 1_000_000,
    burst: 1_000_000,
    clock: { now: () => Date.now() },
  });

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-expansion-edge-test',
  });
  tenantDb = createTenantDb(pool);
  keyProvider = buildBroadcastsKeyProvider();
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupBroadcastProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('broadcast expansion edge cases', () => {
  it('a_cancel_committed_mid_expansion_stops_the_very_next_claim_regardless_of_progress', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      300,
    );

    // Expand exactly one batch (well under the full 300) so most recipients
    // are still `pending` when the cancel lands.
    const partial = await runExpansionBatch(
      { tenantDb, budget: unlimitedBudget(), batchSize: 100 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(partial.kind).toBe('batch');
    const midway = await statementsFor(pool, tenant.clientId);
    expect(midway.inserted).toBe(100);

    await pool.query(
      `INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor)
       VALUES ($1, 1000000, 'active', 100)`,
      [tenant.clientId],
    );
    await cancelBroadcast(
      { tenantDb, publishWake: () => {}, runBookkeeping: noopBookkeeping },
      { kind: 'user', userId: '00000000-0000-0000-0000-00000000aaaa' },
      { clientId: tenant.clientId, id: campaignId },
    );

    // The claim predicate stops immediately - no new claim possible even
    // though 100 jobs already sit `queued`.
    expect(await tryClaim(tenantDb, tenant.clientId, tenant.instanceId)).toBe(false);

    // A further expansion attempt is also a no-op: the campaign is no longer
    // `expanding`, so the worker returns `done` without inserting more.
    const afterCancel = await runExpansionBatch(
      { tenantDb, budget: unlimitedBudget(), batchSize: 100 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(afterCancel).toEqual({ kind: 'done' });
    const final = await statementsFor(pool, tenant.clientId);
    expect(final.inserted).toBe(100);

    const rows = await jobRows(pool, tenant.clientId, campaignId);
    expect(rows.every((r) => r.status === 'queued')).toBe(true);
  });

  it('a_future_scheduled_at_keeps_every_expanded_job_unclaimable_until_that_instant', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      5,
    );
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(`UPDATE campaigns SET scheduled_at = $2 WHERE id = $1`, [campaignId, future]);
    await pool.query(
      `INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor)
       VALUES ($1, 1000000, 'active', 100)`,
      [tenant.clientId],
    );

    await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );

    const scheduledAtRows = await pool.query<{ scheduled_at: Date; next_attempt_at: Date }>(
      `SELECT scheduled_at, next_attempt_at FROM message_jobs WHERE client_id = $1 AND campaign_id = $2`,
      [tenant.clientId, campaignId],
    );
    expect(scheduledAtRows.rows).toHaveLength(5);
    for (const row of scheduledAtRows.rows) {
      expect(row.scheduled_at.getTime()).toBe(future.getTime());
      expect(row.next_attempt_at.getTime()).toBe(future.getTime());
    }

    // The real claim predicate refuses these jobs right now.
    expect(await tryClaim(tenantDb, tenant.clientId, tenant.instanceId)).toBe(false);

    // Move `scheduled_at` into the past to prove the SAME rows become
    // claimable once their instant arrives (never re-expanded, never
    // duplicated - the same job row that was already unclaimable).
    await pool.query(
      `UPDATE message_jobs SET scheduled_at = now() - interval '1 minute',
              next_attempt_at = now() - interval '1 minute'
        WHERE client_id = $1 AND campaign_id = $2`,
      [tenant.clientId, campaignId],
    );
    expect(await tryClaim(tenantDb, tenant.clientId, tenant.instanceId)).toBe(true);
  });

  it('two_different_clients_expansion_workers_run_fully_concurrently_the_advisory_lock_is_per_client', async () => {
    const a = await seedExpandingCampaign(pool, tenantDb, keyProvider, probeClientIds, 300);
    const b = await seedExpandingCampaign(pool, tenantDb, keyProvider, probeClientIds, 300);

    const [resultA, resultB] = await Promise.all([
      runExpansionToCompletion(
        { tenantDb, budget: unlimitedBudget() },
        { campaignId: a.campaignId, clientId: a.tenant.clientId },
      ),
      runExpansionToCompletion(
        { tenantDb, budget: unlimitedBudget() },
        { campaignId: b.campaignId, clientId: b.tenant.clientId },
      ),
    ]);

    expect(resultA).toEqual({ kind: 'done' });
    expect(resultB).toEqual({ kind: 'done' });

    const countsA = await statementsFor(pool, a.tenant.clientId);
    const countsB = await statementsFor(pool, b.tenant.clientId);
    expect(countsA.inserted).toBe(300);
    expect(countsB.inserted).toBe(300);

    const crossLeak = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs
        WHERE client_id = $1 AND campaign_id = $2`,
      [b.tenant.clientId, a.campaignId],
    );
    expect(crossLeak.rows[0]?.count).toBe('0');
  });

  it('a_slow_tenant_db_wrapper_does_not_change_the_expansion_outcome', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      250,
    );

    const slowTenantDb: TenantDb = {
      async withTenant(clientId, fn) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return tenantDb.withTenant(clientId, fn);
      },
    };

    const result = await runExpansionToCompletion(
      { tenantDb: slowTenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );
    expect(result).toEqual({ kind: 'done' });

    const counts = await statementsFor(pool, tenant.clientId);
    expect(counts.inserted).toBe(250);
    expect(counts.refs).toBe(250);
  });
});
