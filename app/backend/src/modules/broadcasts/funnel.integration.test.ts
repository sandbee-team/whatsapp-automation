import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { progressPayloadFor, recomputeCampaignFunnel } from './funnel.repo.js';
import {
  cleanupBroadcastProbeClients,
  seedBroadcastTenant,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { readCounters, seedCampaignWithRecipients } from './__tests__/funnel-test-support.js';

/**
 * funnel.integration.test.ts (P23a Unit U2) - real-DB proof of the
 * progress-funnel recompute: exact recount-after-crash reconciliation, the
 * `completed` writer's exact gating, and at-most-one `campaign.progress`
 * emit per recompute (only on change). The cross-tenant sweep isolation
 * proof lives in the sibling `funnel-sweep-tenant-isolation.integration.
 * test.ts` (max-lines split, same idiom as `expansion-counters-c1fix.
 * integration.test.ts`'s split from `expansion.integration.test.ts`).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-funnel-test',
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

describe('progress funnel recompute (P23a Unit U2)', () => {
  it('funnel_counters_match_a_full_recount_after_a_crash', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedCampaignWithRecipients(
      pool,
      tenant,
      'running',
      {
        pending: 3,
        skipped: 2,
        queued: 4,
        sent: 5,
        delivered: 2,
        read: 1,
        failed: 1,
        cancelled: 2,
      },
      true,
    );

    // Corrupt campaign_counters to arbitrary wrong numbers - simulates a
    // crash mid-batch that left the rollup stale.
    await pool.query(
      `UPDATE campaign_counters SET total = 999, pending = 999, skipped = 999, queued = 999,
              sent = 999, delivered = 999, read = 999, failed = 999, cancelled = 999,
              charged_minor = 1
        WHERE campaign_id = $1`,
      [campaignId],
    );

    const first = await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    expect(first.changed).toBe(true);

    expect(await readCounters(pool, campaignId)).toEqual({
      total: 20,
      pending: 3,
      skipped: 2,
      queued: 4,
      sent: 5,
      delivered: 2,
      read: 1,
      failed: 1,
      cancelled: 2,
      charged_minor: '75',
    });

    const beforeXmin = await pool.query<{ xmin: string }>(
      `SELECT xmin::text FROM campaign_counters WHERE campaign_id = $1`,
      [campaignId],
    );

    const second = await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    expect(second.changed).toBe(false);

    const afterXmin = await pool.query<{ xmin: string }>(
      `SELECT xmin::text FROM campaign_counters WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(afterXmin.rows[0]?.xmin).toBe(beforeXmin.rows[0]?.xmin);
  });

  it('completed_is_written_only_when_no_recipient_remains_non_terminal', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);

    // running + expand_done_at + one queued recipient -> stays running.
    const runningWithQueued = await seedCampaignWithRecipients(
      pool,
      tenant,
      'running',
      { queued: 1 },
      true,
    );
    await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId: runningWithQueued,
    });
    let status = await pool.query<{ status: string }>(
      `SELECT status FROM campaigns WHERE id = $1`,
      [runningWithQueued],
    );
    expect(status.rows[0]?.status).toBe('running');

    // Move the queued recipient to sent -> now fully drained -> completed.
    await pool.query(`UPDATE campaign_recipients SET status = 'sent' WHERE campaign_id = $1`, [
      runningWithQueued,
    ]);
    const result = await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId: runningWithQueued,
    });
    expect(result.completed).toBe(true);
    status = await pool.query<{ status: string }>(`SELECT status FROM campaigns WHERE id = $1`, [
      runningWithQueued,
    ]);
    expect(status.rows[0]?.status).toBe('completed');

    // paused + fully drained -> stays paused (never completed by this path).
    const pausedDrained = await seedCampaignWithRecipients(
      pool,
      tenant,
      'paused',
      { sent: 1 },
      true,
    );
    await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId: pausedDrained,
    });
    status = await pool.query<{ status: string }>(`SELECT status FROM campaigns WHERE id = $1`, [
      pausedDrained,
    ]);
    expect(status.rows[0]?.status).toBe('paused');

    // running, expand_done_at IS NULL, fully drained -> stays running.
    const runningNotExpandDone = await seedCampaignWithRecipients(
      pool,
      tenant,
      'running',
      { sent: 1 },
      false,
    );
    await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId: runningNotExpandDone,
    });
    status = await pool.query<{ status: string }>(`SELECT status FROM campaigns WHERE id = $1`, [
      runningNotExpandDone,
    ]);
    expect(status.rows[0]?.status).toBe('running');
  });

  it('campaign_progress_is_emitted_at_most_once_per_recompute_and_only_on_change', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedCampaignWithRecipients(
      pool,
      tenant,
      'running',
      { queued: 3 },
      false,
    );

    const countOutbox = async (): Promise<number> => {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM outbox_events
          WHERE event_type = 'campaign.progress' AND entity_id = $1`,
        [campaignId],
      );
      return Number(result.rows[0]?.count ?? 0);
    };

    expect(await countOutbox()).toBe(0);

    const first = await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    expect(first.changed).toBe(true);
    expect(await countOutbox()).toBe(1);

    const counters = await readCounters(pool, campaignId);
    const eventResult = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM outbox_events WHERE event_type = 'campaign.progress' AND entity_id = $1`,
      [campaignId],
    );
    expect(eventResult.rows[0]?.payload).toEqual(progressPayloadFor(campaignId, counters));

    // No change -> +0.
    const second = await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    expect(second.changed).toBe(false);
    expect(await countOutbox()).toBe(1);

    // A change -> +1.
    await pool.query(
      `UPDATE campaign_recipients SET status = 'sent'
        WHERE id = (SELECT id FROM campaign_recipients WHERE campaign_id = $1 AND status = 'queued' LIMIT 1)`,
      [campaignId],
    );
    const third = await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    expect(third.changed).toBe(true);
    expect(await countOutbox()).toBe(2);
  });
});
