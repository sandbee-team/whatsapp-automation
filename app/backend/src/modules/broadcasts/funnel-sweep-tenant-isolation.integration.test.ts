import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { recomputeCampaignFunnel } from './funnel.repo.js';
import { runOneFunnelRecomputeSweep } from './funnel.sweep.js';
import {
  cleanupBroadcastProbeClients,
  seedBroadcastTenant,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { readCounters, seedCampaignWithRecipients } from './__tests__/funnel-test-support.js';

/**
 * funnel-sweep-tenant-isolation.integration.test.ts (P23a Unit U2) - sibling
 * of `funnel.integration.test.ts` (max-lines split, same idiom as
 * `expansion-counters-c1fix.integration.test.ts`'s split from
 * `expansion.integration.test.ts`): the cross-tenant sweep-isolation proof.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-funnel-isolation-test',
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

describe('progress funnel sweep tenant isolation (P23a Unit U2)', () => {
  it('the_recompute_sweep_never_touches_another_tenants_campaign', async () => {
    const tenantA = await seedBroadcastTenant(pool, probeClientIds);
    const tenantB = await seedBroadcastTenant(pool, probeClientIds);

    const campaignA = await seedCampaignWithRecipients(
      pool,
      tenantA,
      'running',
      { queued: 2 },
      false,
    );
    const campaignB = await seedCampaignWithRecipients(
      pool,
      tenantB,
      'running',
      { queued: 3 },
      false,
    );

    await pool.query(`UPDATE campaign_counters SET total = 999 WHERE campaign_id = ANY($1)`, [
      [campaignA, campaignB],
    ]);

    await runOneFunnelRecomputeSweep({ pool, tenantDb, mode: 'active' });

    const countersA = await readCounters(pool, campaignA);
    const countersB = await readCounters(pool, campaignB);
    expect(countersA.total).toBe(2);
    expect(countersB.total).toBe(3);

    const rowsA = await pool.query<{ client_id: string }>(
      `SELECT client_id::text FROM campaign_counters WHERE campaign_id = $1`,
      [campaignA],
    );
    expect(rowsA.rows[0]?.client_id).toBe(tenantA.clientId);

    const outboxA = await pool.query<{ client_id: string }>(
      `SELECT client_id::text FROM outbox_events WHERE entity_id = $1 AND event_type = 'campaign.progress'`,
      [campaignA],
    );
    for (const row of outboxA.rows) {
      expect(row.client_id).toBe(tenantA.clientId);
    }

    // Recomputing campaign A under tenant B's clientId changes nothing for
    // A: `recountRecipients` scoped to tenant B sees zero of campaign A's
    // recipients (RLS + explicit client_id predicate), and the reconcile
    // upsert's own `client_id = EXCLUDED.client_id` guard refuses to touch
    // a counters row owned by a different tenant - it fails loudly instead
    // of silently zeroing another tenant's row.
    await pool.query(`UPDATE campaign_counters SET total = 12345 WHERE campaign_id = $1`, [
      campaignA,
    ]);
    await expect(
      recomputeCampaignFunnel(tenantDb, { clientId: tenantB.clientId, campaignId: campaignA }),
    ).rejects.toThrow('campaign_counters row missing after upsert');
    const afterForeignAttempt = await readCounters(pool, campaignA);
    expect(afterForeignAttempt.total).toBe(12345);
  });
});
