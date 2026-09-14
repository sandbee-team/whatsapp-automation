import { bindQueryParams, createPool, createTenantDb, loadQuery, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { runCancelBookkeepingBatch } from './cancel-bookkeeping.js';
import {
  cleanupBroadcastProbeClients,
  seedBroadcastTenant,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { seedCancelledCampaign } from './__tests__/cancel-bookkeeping-c1fix-support.js';

/**
 * cancel-bookkeeping-c1fix.integration.test.ts (P23 C1 fix round, unit F1) -
 * regression coverage for two confirmed findings against `cancel-
 * bookkeeping.ts`: (1) the discovery query never terminates for a
 * fully-bookkept cancelled campaign, starving a later-cancelled one; plus
 * the orchestrator addendum: `campaign_counters` was never adjusted by the
 * stamp batches, and a resumed sweep on an already-finished campaign must
 * change nothing (0 UPDATE statements). The index-scan and error-logging
 * proofs live in the sibling `cancel-bookkeeping-c1fix-edge.integration.
 * test.ts` (max-lines split - shared fixture helpers in `__tests__/
 * cancel-bookkeeping-c1fix-support.ts`).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-cancel-bookkeeping-c1fix-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupBroadcastProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('cancel bookkeeping - C1 fix round (F1)', () => {
  it('a_finished_cancelled_campaign_is_not_returned_by_discovery', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const finishedCampaignId = await seedCancelledCampaign(pool, tenant, 0, 0, 0);
    // Fully bookkept: no pending/queued recipients, no queued jobs left.

    const query = await loadQuery('broadcast-cancel-bookkeeping-pending');
    const result = await pool.query<{ id: string }>(
      query.text,
      bindQueryParams(query, { limit: 100 }),
    );

    expect(result.rows.map((r) => r.id)).not.toContain(finishedCampaignId);
  });

  it('a_later_cancelled_campaign_with_pending_work_is_returned_despite_25_older_finished_ones', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    for (let i = 0; i < 25; i += 1) {
      await seedCancelledCampaign(pool, tenant, 0, 0, 0);
    }
    const laterCampaignId = await seedCancelledCampaign(pool, tenant, 1, 0, 0);

    const query = await loadQuery('broadcast-cancel-bookkeeping-pending');
    const result = await pool.query<{ id: string }>(
      query.text,
      bindQueryParams(query, { limit: 20 }),
    );

    expect(result.rows.map((r) => r.id)).toContain(laterCampaignId);
  });

  it('running_the_sweep_twice_on_a_finished_campaign_does_zero_updates_the_second_time', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedCancelledCampaign(pool, tenant, 3, 5, 8);

    const first = await runCancelBookkeepingBatch(tenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    expect(first.recipientsStamped).toBe(8);
    expect(first.jobsStamped).toBe(8);

    const counters = await pool.query<{
      pending: number;
      queued: number;
      cancelled: number;
      total: number;
    }>(
      `SELECT pending, queued, cancelled, total FROM campaign_counters
        WHERE campaign_id = $1 AND client_id = $2`,
      [campaignId, tenant.clientId],
    );
    expect(counters.rows[0]).toEqual({ pending: 0, queued: 0, cancelled: 8, total: 8 });

    const statements: string[] = [];
    const recordingTenantDb: TenantDb = {
      async withTenant(clientId, fn) {
        return tenantDb.withTenant(clientId, (tx) =>
          fn({
            query: (async (sql: string, params?: unknown[]) => {
              if (/^\s*UPDATE\b/i.test(sql)) statements.push('update');
              return tx.query(sql, params);
            }) as never,
          }),
        );
      },
    };

    const second = await runCancelBookkeepingBatch(recordingTenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    expect(second.recipientsStamped).toBe(0);
    expect(second.jobsStamped).toBe(0);
    expect(statements).toHaveLength(0);

    const countersAfter = await pool.query<{
      pending: number;
      queued: number;
      cancelled: number;
      total: number;
    }>(
      `SELECT pending, queued, cancelled, total FROM campaign_counters
        WHERE campaign_id = $1 AND client_id = $2`,
      [campaignId, tenant.clientId],
    );
    expect(countersAfter.rows[0]).toEqual({ pending: 0, queued: 0, cancelled: 8, total: 8 });
  });
});
