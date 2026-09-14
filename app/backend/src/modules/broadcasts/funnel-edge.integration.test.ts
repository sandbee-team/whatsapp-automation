import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { completeIfDrained, recomputeCampaignFunnel } from './funnel.repo.js';
import {
  cleanupBroadcastProbeClients,
  seedBroadcastTenant,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { readCounters, seedCampaignWithRecipients } from './__tests__/funnel-test-support.js';
import { countOutbox } from './__tests__/funnel-edge-support.js';

/**
 * funnel-edge.integration.test.ts (P23a test-engineer hardening pass) -
 * concurrency + completion-gating edge cases over `recomputeCampaignFunnel`:
 * concurrent recomputes converge on the recount and emit at most one
 * outbox row per changed result, a pause committed mid-drain-check blocks
 * completion, and `expand_done_at` gating (not-yet-set / third-recompute
 * no-op). Discovery/payload-shape edge cases live in the max-lines sibling
 * `funnel-c2.integration.test.ts`.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-funnel-edge-test',
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

describe('progress funnel recompute edge cases (P23a hardening)', () => {
  it('two_concurrent_recomputes_converge_on_the_recount_and_outbox_rows_match_changed_count', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedCampaignWithRecipients(
      pool,
      tenant,
      'running',
      { queued: 3, sent: 2 },
      false,
    );
    // Corrupt the counters row so both concurrent recomputes observe a change.
    await pool.query(
      `UPDATE campaign_counters SET total = 999, sent = 999 WHERE campaign_id = $1`,
      [campaignId],
    );

    const before = await countOutbox(pool, campaignId);
    const [first, second] = await Promise.all([
      recomputeCampaignFunnel(tenantDb, { clientId: tenant.clientId, campaignId }),
      recomputeCampaignFunnel(tenantDb, { clientId: tenant.clientId, campaignId }),
    ]);
    const after = await countOutbox(pool, campaignId);

    const changedCount = [first, second].filter((r) => r.changed).length;
    expect(after - before).toBe(changedCount);
    expect(changedCount).toBeGreaterThanOrEqual(1);

    const counters = await readCounters(pool, campaignId);
    expect(counters.total).toBe(5);
    expect(counters.queued).toBe(3);
    expect(counters.sent).toBe(2);
  });

  it('a_pause_committed_between_the_drained_check_and_completion_leaves_it_paused', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedCampaignWithRecipients(pool, tenant, 'running', { sent: 1 }, true);

    // Establish the reconciled baseline while still 'running' (this recompute's
    // own `changed` is expected true - it is not part of what this test proves).
    await recomputeCampaignFunnel(tenantDb, { clientId: tenant.clientId, campaignId });

    // Simulate the pause committing "between the drained check and
    // completion" by flipping status to paused BEFORE completeIfDrained
    // ever runs (completeIfDrained re-reads status fresh - it cannot
    // observe a state it hasn't read yet, so this is the exact race it
    // must reject).
    await pool.query(`UPDATE campaigns SET status = 'paused' WHERE id = $1`, [campaignId]);

    const completed = await tenantDb.withTenant(tenant.clientId, (tx) =>
      completeIfDrained(tx, tenant.clientId, campaignId),
    );
    expect(completed).toBe(false);

    const status = await pool.query<{ status: string }>(
      `SELECT status FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(status.rows[0]?.status).toBe('paused');

    const before = await countOutbox(pool, campaignId);
    const result = await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    expect(result.completed).toBe(false);
    const finalStatus = await pool.query<{ status: string }>(
      `SELECT status FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(finalStatus.rows[0]?.status).toBe('paused');
    // No spurious progress event just because recompute ran on a paused campaign
    // with nothing else changed.
    expect(await countOutbox(pool, campaignId)).toBe(before);
  });

  it('expand_done_at_null_never_completes_setting_it_completes_on_next_recompute_a_third_changes_nothing', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedCampaignWithRecipients(
      pool,
      tenant,
      'running',
      { sent: 1 },
      false,
    );

    const first = await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    expect(first.completed).toBe(false);
    let status = await pool.query<{ status: string }>(
      `SELECT status FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(status.rows[0]?.status).toBe('running');

    await pool.query(`UPDATE campaigns SET expand_done_at = now() WHERE id = $1`, [campaignId]);
    const beforeSecond = await countOutbox(pool, campaignId);
    const second = await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    expect(second.completed).toBe(true);
    expect(await countOutbox(pool, campaignId)).toBe(beforeSecond + 1);
    status = await pool.query<{ status: string }>(`SELECT status FROM campaigns WHERE id = $1`, [
      campaignId,
    ]);
    expect(status.rows[0]?.status).toBe('completed');

    const xminBefore = await pool.query<{ xmin: string }>(
      `SELECT xmin::text FROM campaign_counters WHERE campaign_id = $1`,
      [campaignId],
    );
    const beforeThird = await countOutbox(pool, campaignId);
    const third = await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    expect(third.changed).toBe(false);
    expect(third.completed).toBe(false);
    expect(await countOutbox(pool, campaignId)).toBe(beforeThird);
    const xminAfter = await pool.query<{ xmin: string }>(
      `SELECT xmin::text FROM campaign_counters WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(xminAfter.rows[0]?.xmin).toBe(xminBefore.rows[0]?.xmin);
  });
});
