import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { cleanupWaGroups, seedWaGroup } from '../groups/__tests__/groups-test-helpers.js';
import { runSnapshotToCompletion } from './snapshot.worker.js';
import { runExpansionToCompletion } from './expansion.worker.js';
import { createExpansionBudget } from './expansion-budget.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedBroadcastTenant,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import {
  drainGroupsThroughPacing,
  seedGroupsCampaign,
  seedGroupsDrainPacing,
} from './__tests__/groups-broadcast-test-helpers.js';

/**
 * groups-broadcast.integration.test.ts (P24 groups-messaging Unit U6, step 9)
 * - `campaigns.target_kind = 'groups'` end-to-end: snapshot (send-enabled/
 * cap/announce skip precedence) -> expansion (NULL e164) -> the real drain
 * (`GROUP_DAILY_CAP` deferral) -> the replay-safety proof. Pre-flight and
 * create-time rules are the `groups-broadcast-preflight.integration.test.ts`
 * sibling (max-lines split).
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
    applicationName: 'groups-broadcast-test',
  });
  tenantDb = createTenantDb(pool);
  keyProvider = buildBroadcastsKeyProvider();
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupBroadcastProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('groups broadcast (P24 groups-messaging Unit U6)', () => {
  it('a_group_broadcast_expands_only_to_send_enabled_groups_and_obeys_the_group_cap', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    for (let i = 0; i < 12; i += 1) {
      await seedWaGroup(pool, {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        sendEnabled: true,
      });
    }
    await seedWaGroup(pool, {
      clientId: tenant.clientId,
      instanceId: tenant.instanceId,
      sendEnabled: false,
    });
    await seedWaGroup(pool, {
      clientId: tenant.clientId,
      instanceId: tenant.instanceId,
      sendEnabled: true,
      isAnnounce: true,
      ourRole: 'member',
    });

    const campaignId = await seedGroupsCampaign(pool, tenant);
    await seedGroupsDrainPacing(pool, tenant.clientId, tenant.instanceId, 10);

    const snap = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000, keyProvider },
      { campaignId, clientId: tenant.clientId },
    );
    expect(snap).toEqual({ kind: 'done', audienceCount: 14 });

    const recipients = await pool.query<{ status: string; skip_reason: string | null }>(
      `SELECT status, skip_reason FROM campaign_recipients WHERE campaign_id = $1 ORDER BY id`,
      [campaignId],
    );
    const pending = recipients.rows.filter((r) => r.status === 'pending');
    const skipped = recipients.rows.filter((r) => r.status === 'skipped');
    expect(pending).toHaveLength(12);
    expect(skipped).toHaveLength(2);
    expect(skipped.map((r) => r.skip_reason).sort()).toEqual([
      'ANNOUNCE_MEMBER_ONLY',
      'NOT_SEND_ENABLED',
    ]);

    const counters = await pool.query<{ skipped: number }>(
      `SELECT skipped FROM campaign_counters WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(counters.rows[0]?.skipped).toBe(2);

    const expansion = await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget(), batchSize: 500 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(expansion).toEqual({ kind: 'done' });

    const jobs = await pool.query<{ recipient_e164: string | null }>(
      `SELECT recipient_e164 FROM message_jobs WHERE client_id = $1 AND campaign_id = $2`,
      [tenant.clientId, campaignId],
    );
    expect(jobs.rows).toHaveLength(12);
    for (const row of jobs.rows) {
      expect(row.recipient_e164).toBeNull();
    }

    const queuedRecipients = await pool.query<{
      contact_id: string | null;
      group_id: string | null;
    }>(
      `SELECT contact_id, group_id FROM campaign_recipients WHERE campaign_id = $1 AND status = 'queued'`,
      [campaignId],
    );
    expect(queuedRecipients.rows).toHaveLength(12);
    for (const row of queuedRecipients.rows) {
      expect(row.contact_id).toBeNull();
      expect(row.group_id).not.toBeNull();
    }

    const sentCount = await drainGroupsThroughPacing(
      pool,
      tenantDb,
      tenant.clientId,
      tenant.instanceId,
      20,
    );
    expect(sentCount).toBe(10);

    const finalJobs = await pool.query<{
      status: string;
      pacing_deny_reason: string | null;
      attempts: number;
    }>(
      `SELECT status, pacing_deny_reason, attempts FROM message_jobs
        WHERE client_id = $1 AND campaign_id = $2 ORDER BY id`,
      [tenant.clientId, campaignId],
    );
    const sent = finalJobs.rows.filter((r) => r.status === 'sent');
    const stillQueued = finalJobs.rows.filter((r) => r.status === 'queued');
    expect(sent).toHaveLength(10);
    expect(stillQueued).toHaveLength(2);
    for (const row of stillQueued) {
      expect(row.pacing_deny_reason).toBe('GROUP_DAILY_CAP');
      expect(row.attempts).toBe(0);
    }

    const ledger = await pool.query<{ group_sent_count: number; consumed_count: number }>(
      `SELECT group_sent_count, consumed_count FROM pacing_ledger WHERE instance_id = $1`,
      [tenant.instanceId],
    );
    expect(ledger.rows[0]?.group_sent_count).toBe(10);
    expect(ledger.rows[0]?.consumed_count).toBe(10);

    const walletRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM wallet_ledger WHERE client_id = $1 AND price_key = 'group_text'`,
      [tenant.clientId],
    );
    expect(Number(walletRows.rows[0]?.count)).toBe(10);
  });

  it('group_expansion_replay_creates_no_job_without_a_ref', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    for (let i = 0; i < 5; i += 1) {
      await seedWaGroup(pool, {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        sendEnabled: true,
      });
    }
    const campaignId = await seedGroupsCampaign(pool, tenant);

    await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000, keyProvider },
      { campaignId, clientId: tenant.clientId },
    );

    await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget(), batchSize: 500 },
      { campaignId, clientId: tenant.clientId },
    );
    // Replay - the second pass finds every recipient already 'queued', so
    // readExpansionBatch returns zero rows and it resolves 'done' immediately.
    const replay = await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget(), batchSize: 500 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(replay).toEqual({ kind: 'done' });

    const jobs = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs WHERE client_id = $1 AND campaign_id = $2`,
      [tenant.clientId, campaignId],
    );
    expect(jobs.rows[0]?.count).toBe('5');
    const refs = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_job_refs WHERE client_id = $1`,
      [tenant.clientId],
    );
    expect(refs.rows[0]?.count).toBe('5');

    // A second snapshot pass over the same campaign inserts zero new
    // recipient rows - cr_campaign_target_uq holds.
    await pool.query(`UPDATE campaigns SET status = 'snapshotting' WHERE id = $1`, [campaignId]);
    await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000, keyProvider },
      { campaignId, clientId: tenant.clientId },
    );
    const recipientCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipientCount.rows[0]?.count).toBe('5');
  });
});
