import { randomUUID } from 'node:crypto';
import { bindQueryParams, createPool, createTenantDb, loadNamedQuery, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { realtimeEventSchema } from '@wp/contracts';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { progressPayloadFor, recomputeCampaignFunnel } from './funnel.repo.js';
import { runOneFunnelRecomputeSweep } from './funnel.sweep.js';
import {
  cleanupBroadcastProbeClients,
  seedBroadcastTenant,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { readCounters, seedCampaignWithRecipients } from './__tests__/funnel-test-support.js';

/**
 * funnel-c2.integration.test.ts (P23a test-engineer hardening pass,
 * max-lines split of funnel-edge.integration.test.ts) - discovery
 * staleness/terminal-exclusion, NULL-charged_minor summation, and the
 * emitted `campaign.progress` payload's shape against the contracts schema.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-funnel-c2-test',
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

describe('progress funnel discovery/payload edge cases (P23a hardening)', () => {
  it('hourly_discovery_picks_a_completed_never_recomputed_campaign_once_then_stops_once_stale', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedCampaignWithRecipients(
      pool,
      tenant,
      'completed',
      { sent: 1 },
      true,
    );
    await pool.query(`UPDATE campaign_counters SET recomputed_at = NULL WHERE campaign_id = $1`, [
      campaignId,
    ]);
    await pool.query(
      `UPDATE campaigns SET updated_at = now() - interval '30 hours' WHERE id = $1`,
      [campaignId],
    );

    await runOneFunnelRecomputeSweep({ pool, tenantDb, mode: 'hourly' });

    const recomputedAt1 = await pool.query<{ recomputed_at: Date | null }>(
      `SELECT recomputed_at FROM campaign_counters WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recomputedAt1.rows[0]?.recomputed_at).not.toBeNull();

    // Now updated_at is old (set explicitly, still recomputed_at NOT NULL,
    // and campaign.updated_at was NOT touched by the recompute itself since
    // nothing changed) - a second hourly sweep must not pick it again.
    await pool.query(
      `UPDATE campaigns SET updated_at = now() - interval '30 hours' WHERE id = $1`,
      [campaignId],
    );
    const beforeSecondSweep = await pool.query<{ recomputed_at: Date | null }>(
      `SELECT recomputed_at FROM campaign_counters WHERE campaign_id = $1`,
      [campaignId],
    );

    await runOneFunnelRecomputeSweep({ pool, tenantDb, mode: 'hourly' });

    const afterSecondSweep = await pool.query<{ recomputed_at: Date | null }>(
      `SELECT recomputed_at FROM campaign_counters WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(afterSecondSweep.rows[0]?.recomputed_at).toEqual(
      beforeSecondSweep.rows[0]?.recomputed_at,
    );
  });

  it('the_active_discovery_never_returns_a_terminal_campaign', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const terminalId = await seedCampaignWithRecipients(
      pool,
      tenant,
      'completed',
      { sent: 1 },
      true,
    );
    void terminalId;

    // P23a C1 fix round unit F2 - funnel-active is now a keyset rotation
    // scan; binds `cursor` starting at the zero uuid (a full-range walk).
    const activeQuery = await loadNamedQuery('broadcast-funnel-pending', 'funnel-active');
    const result = await pool.query<{ id: string; client_id: string }>(
      activeQuery.text,
      bindQueryParams(activeQuery, {
        limit: 200,
        cursor: '00000000-0000-0000-0000-000000000000',
      }),
    );
    const ids = result.rows.map((r) => r.id);
    expect(ids).not.toContain(terminalId);
  });

  it('recount_with_charged_minor_null_on_some_sent_rows_treats_null_as_zero_exactly', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedCampaignWithRecipients(pool, tenant, 'running', {}, false);
    await pool.query(
      `INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)
       ON CONFLICT (campaign_id) DO NOTHING`,
      [campaignId, tenant.clientId],
    );

    // Two 'sent' rows: one charged 15 (the fixture default), one NULL.
    const groupId1 = randomUUID();
    const groupId2 = randomUUID();
    await pool.query(
      `INSERT INTO campaign_recipients
         (client_id, campaign_id, group_id, recipient_jid, recipient_hash, status, charged_minor)
       VALUES ($1, $2, $3, $4, $5, 'sent', 15)`,
      [tenant.clientId, campaignId, groupId1, `${groupId1}@g.us`, Buffer.from(groupId1)],
    );
    await pool.query(
      `INSERT INTO campaign_recipients
         (client_id, campaign_id, group_id, recipient_jid, recipient_hash, status, charged_minor)
       VALUES ($1, $2, $3, $4, $5, 'sent', NULL)`,
      [tenant.clientId, campaignId, groupId2, `${groupId2}@g.us`, Buffer.from(groupId2)],
    );

    const result = await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    expect(result.changed).toBe(true);
    const counters = await readCounters(pool, campaignId);
    expect(counters.sent).toBe(2);
    expect(counters.charged_minor).toBe('15');
  });

  it('the_emitted_progress_payload_parses_against_the_contracts_realtime_schema', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedCampaignWithRecipients(
      pool,
      tenant,
      'running',
      { queued: 2, sent: 1, delivered: 1, read: 1, failed: 1 },
      false,
    );

    await recomputeCampaignFunnel(tenantDb, { clientId: tenant.clientId, campaignId });

    const eventResult = await pool.query<{ payload: unknown; event_type: string }>(
      `SELECT payload, event_type FROM outbox_events
        WHERE event_type = 'campaign.progress' AND entity_id = $1`,
      [campaignId],
    );
    const row = eventResult.rows[0];
    expect(row).toBeDefined();
    const frame = { type: 'campaign.progress', ...(row?.payload as Record<string, unknown>) };
    const parsed = realtimeEventSchema.parse(frame);
    expect(parsed.type).toBe('campaign.progress');

    const counters = await readCounters(pool, campaignId);
    expect(row?.payload).toEqual(progressPayloadFor(campaignId, counters));
  });
});
