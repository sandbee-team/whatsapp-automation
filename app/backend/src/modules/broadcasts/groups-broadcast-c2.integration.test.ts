import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { cleanupWaGroups, seedWaGroup } from '../groups/__tests__/groups-test-helpers.js';
import { runSnapshotToCompletion } from './snapshot.worker.js';
import { runExpansionToCompletion } from './expansion.worker.js';
import { createExpansionBudget } from './expansion-budget.js';
import { preflightBroadcast } from './preflight.public.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedBroadcastTenant,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { seedGroupsCampaign } from './__tests__/groups-broadcast-test-helpers.js';

/**
 * groups-broadcast-c2.integration.test.ts (P24 C2 test-engineer, scope item
 * 8) - group-broadcast edge cases beyond `groups-broadcast.integration.
 * test.ts`/`groups-broadcast-preflight.integration.test.ts`'s own coverage:
 * `groupIds` containing another tenant's or another instance's group
 * (never snapshotted), duplicate `groupIds`, and an empty audience (zero
 * enabled groups) snapshot/expansion/pre-flight. The "a group disabled
 * between snapshot and expansion" and "local-midnight ledger boundary"
 * cases live in the sibling `groups-broadcast-timing-c2.integration.
 * test.ts` (max-lines split).
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
    applicationName: 'groups-broadcast-c2-test',
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

async function seedGroupsCampaignWithIds(
  pool: TestPool,
  tenant: { clientId: string; instanceId: string },
  groupIds: string[],
): Promise<string> {
  const campaignId = randomUUID();
  await pool.query(
    `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message, priority, target_kind)
     VALUES ($1, $2, $3, 'snapshotting', $4, $5, $6, 'low', 'groups')`,
    [
      campaignId,
      tenant.clientId,
      tenant.instanceId,
      `groups c2 probe campaign ${campaignId}`,
      JSON.stringify({ kind: 'groups', groupIds }),
      JSON.stringify({ kind: 'text', body: 'Hello group!' }),
    ],
  );
  await pool.query('INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)', [
    campaignId,
    tenant.clientId,
  ]);
  return campaignId;
}

describe('groups broadcast c2 - groupIds referencing another tenant or instance', () => {
  it('a_groupId_belonging_to_another_tenant_is_never_snapshotted', async () => {
    const tenantA = await seedBroadcastTenant(pool, probeClientIds);
    const tenantB = await seedBroadcastTenant(pool, probeClientIds);

    const ownGroup = await seedWaGroup(pool, {
      clientId: tenantA.clientId,
      instanceId: tenantA.instanceId,
      sendEnabled: true,
    });
    const foreignGroup = await seedWaGroup(pool, {
      clientId: tenantB.clientId,
      instanceId: tenantB.instanceId,
      sendEnabled: true,
    });

    const campaignId = await seedGroupsCampaignWithIds(pool, tenantA, [
      ownGroup.id,
      foreignGroup.id,
    ]);

    const snap = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000, keyProvider },
      { campaignId, clientId: tenantA.clientId },
    );
    expect(snap).toEqual({ kind: 'done', audienceCount: 1 });

    const recipients = await pool.query<{ group_id: string }>(
      `SELECT group_id FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipients.rows).toHaveLength(1);
    expect(recipients.rows[0]?.group_id).toBe(ownGroup.id);
  });

  it('a_groupId_belonging_to_another_instance_of_the_same_tenant_is_never_snapshotted', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    // A second instance under the SAME client.
    const otherInstanceId = randomUUID();
    await pool.query(
      `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
       VALUES ($1, $2, 'broadcast-probe-other', 'connected', 0)`,
      [otherInstanceId, tenant.clientId],
    );
    await pool.query(
      `INSERT INTO instance_lease_state (instance_id, client_id, current_fence) VALUES ($1, $2, 1)`,
      [otherInstanceId, tenant.clientId],
    );

    const ownGroup = await seedWaGroup(pool, {
      clientId: tenant.clientId,
      instanceId: tenant.instanceId,
      sendEnabled: true,
    });
    const otherInstanceGroup = await seedWaGroup(pool, {
      clientId: tenant.clientId,
      instanceId: otherInstanceId,
      sendEnabled: true,
    });

    const campaignId = await seedGroupsCampaignWithIds(pool, tenant, [
      ownGroup.id,
      otherInstanceGroup.id,
    ]);

    const snap = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000, keyProvider },
      { campaignId, clientId: tenant.clientId },
    );
    expect(snap).toEqual({ kind: 'done', audienceCount: 1 });

    const recipients = await pool.query<{ group_id: string }>(
      `SELECT group_id FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipients.rows).toHaveLength(1);
    expect(recipients.rows[0]?.group_id).toBe(ownGroup.id);

    // Clean up the extra instance explicitly (probeClientIds cleanup deletes
    // whatsapp_instances by client_id, so this row is covered too, but the
    // wa_groups row of the other instance still needs the shared cleanup).
  });
});

describe('groups broadcast c2 - duplicate groupIds', () => {
  it('duplicate_groupIds_in_the_audience_produce_exactly_one_recipient_row_per_group', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const group = await seedWaGroup(pool, {
      clientId: tenant.clientId,
      instanceId: tenant.instanceId,
      sendEnabled: true,
    });

    const campaignId = await seedGroupsCampaignWithIds(pool, tenant, [
      group.id,
      group.id,
      group.id,
    ]);

    const snap = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000, keyProvider },
      { campaignId, clientId: tenant.clientId },
    );
    // snapshot-groups-batch.sql's own `g.id = ANY($group_ids)` predicate
    // matches the ROW at most once regardless of how many times its id is
    // repeated in the array - no per-repeat duplication.
    expect(snap).toEqual({ kind: 'done', audienceCount: 1 });

    const recipients = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipients.rows[0]?.count).toBe('1');
  });
});

describe('groups broadcast c2 - empty audience (zero enabled groups)', () => {
  it('a_campaign_with_zero_matched_groups_snapshots_to_zero_and_expands_to_zero_jobs', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    // Seed one group but leave it NOT send_enabled - the empty-groupIds
    // audience matches every non-left group at the SNAPSHOT count/batch
    // level (see snapshot-groups-{count,batch}.sql), but a not-send_enabled
    // group is written as a SKIPPED recipient, not omitted - "empty
    // audience" here means truly zero groups exist for the instance.
    const campaignId = await seedGroupsCampaign(pool, tenant, 'Hello group!', 'snapshotting');

    const snap = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000, keyProvider },
      { campaignId, clientId: tenant.clientId },
    );
    expect(snap).toEqual({ kind: 'done', audienceCount: 0 });

    const recipients = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipients.rows[0]?.count).toBe('0');

    const expansion = await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget(), batchSize: 500 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(expansion).toEqual({ kind: 'done' });

    const jobs = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs WHERE client_id = $1 AND campaign_id = $2`,
      [tenant.clientId, campaignId],
    );
    expect(jobs.rows[0]?.count).toBe('0');
  });

  it('a_zero_matched_group_preflight_reports_groupsMatched_zero_and_is_not_refused', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedGroupsCampaign(pool, tenant, 'Hello group!', 'draft');
    await pool.query(
      `INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor)
       VALUES ($1, 1000000, 'active', 100)`,
      [tenant.clientId],
    );
    await pool.query(`INSERT INTO client_pricing (client_id, price_list_key) VALUES ($1, $2)`, [
      tenant.clientId,
      'default_inr',
    ]);
    await pool.query(
      `INSERT INTO instance_pacing_state (
         instance_id, client_id, warmup_tier,
         eff_daily_cap, eff_hourly_cap, eff_new_conv_cap,
         eff_gap_min_ms, eff_gap_max_ms, eff_cold_ratio_max, eff_cold_ratio_floor,
         eff_window_start_local, eff_window_end_local, eff_group_daily_cap
       ) VALUES ($1, $2, 4, 600, 100000, 100000, 15000, 15000, 1, 0, '00:00:00', '23:59:59', 10)`,
      [tenant.instanceId, tenant.clientId],
    );

    // Pins the observed behaviour: the preflight succeeds (no refusal error)
    // with a zero-count quote - `buildGroupsPreflightQuote` has no "audience
    // is empty" refusal branch of its own (unlike the contacts path's
    // plan-ceiling check, which never applies to groups at all - see
    // `snapshot.worker.ts`'s own comment on groups having no ceiling
    // authority).
    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: randomUUID() },
      { clientId: tenant.clientId, id: campaignId },
    );

    expect(quote.groups?.groupsMatched).toBe(0);
    expect(quote.groups?.groupsSkipped).toBe(0);
    expect(quote.groups?.reachEstimate).toBe(0);
    expect(quote.billable.count).toBe(0);
    expect(quote.billable.quoteMinor).toBe(0);
  });
});
