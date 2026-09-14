import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createFunnelActiveCursor, runOneFunnelRecomputeSweep } from './funnel.sweep.js';
import {
  cleanupBroadcastProbeClients,
  seedBroadcastTenant,
  type SeededBroadcastTenant,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { readCounters } from './__tests__/funnel-test-support.js';

/**
 * funnel-rotation-c1fix.integration.test.ts (P23a C1 fix round, unit F2) -
 * MAJOR 3: `funnel-active` discovery must rotate fairly over the new
 * `campaigns_funnel_discovery_idx` partial index instead of starving
 * campaigns behind >LIMIT `paused`/long-running rows sorted first by
 * `updated_at`. Deterministic ordering is achieved by seeding explicit,
 * hand-picked campaign ids (never relying on `randomUUID()` ordering).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-funnel-rotation-c1fix-test',
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

/** Seeds a campaign with an EXPLICIT id (never `seedBroadcastCampaign`'s own `randomUUID()`) plus its zero counters row - deterministic id ordering is the whole point of this rotation proof. */
async function seedCampaignWithId(
  pool: TestPool,
  tenant: SeededBroadcastTenant,
  campaignId: string,
  status: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'low')`,
    [
      campaignId,
      tenant.clientId,
      tenant.instanceId,
      status,
      `funnel rotation probe ${campaignId}`,
      JSON.stringify({ kind: 'contacts', tagIds: [tenant.tagId], contactIds: [] }),
      JSON.stringify({ kind: 'text', body: 'hi' }),
    ],
  );
  await pool.query(`INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)`, [
    campaignId,
    tenant.clientId,
  ]);
  await pool.query(
    `INSERT INTO campaign_recipients
       (client_id, campaign_id, group_id, recipient_jid, recipient_hash, status, charged_minor)
     VALUES ($1, $2, $3, $4, $5, 'queued', NULL)`,
    [tenant.clientId, campaignId, randomUUID(), `${randomUUID()}@g.us`, Buffer.from(randomUUID())],
  );
}

function idFor(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(12, '0')}`;
}

describe('funnel-active discovery rotation (P23a C1 fix round, unit F2)', () => {
  it('the_active_sweep_reaches_every_active_campaign_within_ceil_n_over_limit_ticks', async () => {
    const limit = 5;
    const tenantA = await seedBroadcastTenant(pool, probeClientIds);
    const tenantB = await seedBroadcastTenant(pool, probeClientIds);

    // Tenant A: `limit` PAUSED campaigns, ids sorting FIRST (`1111...`).
    const aIds: string[] = [];
    for (let i = 1; i <= limit; i += 1) {
      const id = idFor('11111111-1111-1111-1111-', i);
      aIds.push(id);
      await seedCampaignWithId(pool, tenantA, id, 'paused');
    }

    // Tenant B: ONE running campaign, id sorting LAST (`ffff...`).
    const bId = idFor('ffffffff-ffff-ffff-ffff-', 1);
    await seedCampaignWithId(pool, tenantB, bId, 'running');

    // Corrupt every counters row so a correct recompute is observable.
    await pool.query(`UPDATE campaign_counters SET total = 999 WHERE campaign_id = ANY($1)`, [
      [...aIds, bId],
    ]);

    const activeCursor = createFunnelActiveCursor();
    await runOneFunnelRecomputeSweep({
      pool,
      tenantDb,
      mode: 'active',
      maxCampaignsPerSweep: limit,
      activeCursor,
    });
    await runOneFunnelRecomputeSweep({
      pool,
      tenantDb,
      mode: 'active',
      maxCampaignsPerSweep: limit,
      activeCursor,
    });

    for (const id of aIds) {
      const counters = await readCounters(pool, id);
      expect(counters.total).toBe(1);
    }
    const bCounters = await readCounters(pool, bId);
    expect(bCounters.total).toBe(1);
  });

  it('the_cursor_wraps_after_a_short_tick', async () => {
    // Discovery is deliberately fleet-wide/cross-tenant (this file's own
    // header, `funnel.sweep.ts`'s module doc) - the shared dev DB always
    // carries OTHER active campaigns outside this test's own probe tenant
    // (permanently, by design: `db/seeds/queue-explain-fixture.sql`'s two
    // deterministic P23 U3 rows `c0000000-...0001`/`...0002`; transiently,
    // any sibling suite's leftover probe row). A fixed `limit` small enough
    // to be beaten by that ambient population turns "one row < limit -> the
    // tick wraps" false without this test itself being wrong - core-
    // invariants' "inject the ambient input, assert the exact value" rule:
    // read the SAME fleet-wide population the sweep's own discovery query
    // counts, then size `limit` so this test's own single row is always the
    // short tick regardless of how many other active campaigns exist.
    const ambient = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaigns
         WHERE status IN ('snapshotting', 'expanding', 'running', 'paused')`,
    );
    const limit = Number(ambient.rows[0]?.count ?? '0') + 5;
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const soleId = idFor('22222222-2222-2222-2222-', 1);
    await seedCampaignWithId(pool, tenant, soleId, 'running');

    const activeCursor = createFunnelActiveCursor();
    await runOneFunnelRecomputeSweep({
      pool,
      tenantDb,
      mode: 'active',
      maxCampaignsPerSweep: limit,
      activeCursor,
    });
    // Ambient population + this test's own row is comfortably under `limit`
    // -> the tick wraps the cursor back to the zero uuid.
    expect(activeCursor.get()).toBe('00000000-0000-0000-0000-000000000000');

    await pool.query(`UPDATE campaign_counters SET total = 999 WHERE campaign_id = $1`, [soleId]);

    await runOneFunnelRecomputeSweep({
      pool,
      tenantDb,
      mode: 'active',
      maxCampaignsPerSweep: limit,
      activeCursor,
    });
    const counters = await readCounters(pool, soleId);
    expect(counters.total).toBe(1);
  });

  it('the_active_discovery_uses_the_partial_index', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    for (let i = 1; i <= 50; i += 1) {
      await seedCampaignWithId(pool, tenant, idFor('33333333-3333-3333-3333-', i), 'running');
    }
    await pool.query('ANALYZE campaigns');

    const client = await pool.connect();
    try {
      // Determinism device, not a production setting: inside this one
      // transaction the planner may not fall back to a seq scan just because
      // the probe table is tiny, so the assertion below is about the INDEX
      // SHAPE (does the partial index answer the keyset predicate?), never
      // about table size / ANALYZE timing (core-invariants: no ambient state).
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const result = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) SELECT c.id, c.client_id
           FROM campaigns c
          WHERE c.status IN ('snapshotting', 'expanding', 'running', 'paused')
            AND c.id > $1
          ORDER BY c.id ASC
          LIMIT $2`,
        ['00000000-0000-0000-0000-000000000000', 5],
      );
      const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');
      const indexRow = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE indexname = 'campaigns_funnel_discovery_idx'`,
      );
      expect(indexRow.rows).toHaveLength(1);

      // Unconditional: the partial index answers the rotation predicate and
      // the keyset walk needs no Sort node (the old `ORDER BY updated_at`
      // shape did).
      expect(plan).toContain('campaigns_funnel_discovery_idx');
      expect(plan).toMatch(/Index (Only )?Scan using campaigns_funnel_discovery_idx/);
      expect(plan).toMatch(/Index Cond: \(id > /);
      expect(plan).not.toContain('Sort');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('terminal_campaigns_are_never_returned_by_the_active_section', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const terminalId = idFor('44444444-4444-4444-4444-', 1);
    await seedCampaignWithId(pool, tenant, terminalId, 'completed');
    await pool.query(`UPDATE campaign_counters SET total = 999 WHERE campaign_id = $1`, [
      terminalId,
    ]);

    await runOneFunnelRecomputeSweep({
      pool,
      tenantDb,
      mode: 'active',
      maxCampaignsPerSweep: 200,
      activeCursor: createFunnelActiveCursor(),
    });

    const counters = await readCounters(pool, terminalId);
    expect(counters.total).toBe(999);
  });
});
