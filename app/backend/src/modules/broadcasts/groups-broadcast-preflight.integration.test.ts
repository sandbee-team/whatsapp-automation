import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupWaGroups,
  seedWaGroup,
  syntheticGroupJid,
} from '../groups/__tests__/groups-test-helpers.js';
import { createBroadcast } from './lifecycle.service.js';
import { preflightBroadcast } from './preflight.public.js';
import { GroupsAudienceTemplateVarsError } from './broadcasts.errors.js';
import {
  cleanupBroadcastProbeClients,
  seedBroadcastTenant,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { seedGroupsCampaign } from './__tests__/groups-broadcast-test-helpers.js';

/**
 * groups-broadcast-preflight.integration.test.ts (P24 groups-messaging Unit
 * U6, step 9) - split out of `groups-broadcast.integration.test.ts` (max-
 * lines cap): the pre-flight quote (reach/cap/off-at-tier) and the two
 * create-time rules (template-vars rejection, `target_kind` derivation).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-broadcast-preflight-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupBroadcastProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('groups broadcast pre-flight + create-time rules (P24 groups-messaging Unit U6)', () => {
  it('a_groups_preflight_reports_reach_cap_and_off_at_tier', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    let reachTotal = 0;
    for (let i = 0; i < 12; i += 1) {
      const participantCount = 10 + i;
      reachTotal += participantCount;
      await seedWaGroup(pool, {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        sendEnabled: true,
        participantCount,
      });
    }
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
         eff_window_start_local, eff_window_end_local, eff_group_daily_cap, pacing_timezone
       ) VALUES ($1, $2, 4, 600, 100000, 100000, 15000, 15000, 1, 0, '00:00:00', '23:59:59', 10, 'Asia/Kolkata')`,
      [tenant.instanceId, tenant.clientId],
    );
    await pool.query(
      `INSERT INTO pacing_ledger (client_id, instance_id, ledger_date, group_sent_count)
       VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Kolkata')::date, 3)`,
      [tenant.clientId, tenant.instanceId],
    );

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: randomUUID() },
      { clientId: tenant.clientId, id: campaignId },
    );

    expect(quote.groups?.groupsMatched).toBe(12);
    expect(quote.groups?.groupsSkipped).toBe(0);
    expect(quote.groups?.reachEstimate).toBe(reachTotal);
    expect(quote.groups?.effGroupDailyCap).toBe(10);
    expect(quote.groups?.groupSentToday).toBe(3);
    expect(quote.groups?.groupRemainingToday).toBe(7);
    expect(quote.groups?.capIsZeroAtTier).toBe(false);
    expect(quote.billable.priceKey).toBe('group_text');
    expect(quote.estimate.totalDays).toBe(2);

    // Tier switch to cap 0 - capIsZeroAtTier flips, totalDays becomes null.
    await pool.query(
      `UPDATE instance_pacing_state SET eff_group_daily_cap = 0 WHERE instance_id = $1`,
      [tenant.instanceId],
    );
    await pool.query(`UPDATE campaigns SET status = 'draft', quote_minor = NULL WHERE id = $1`, [
      campaignId,
    ]);
    const quoteZero = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: randomUUID() },
      { clientId: tenant.clientId, id: campaignId },
    );
    expect(quoteZero.groups?.capIsZeroAtTier).toBe(true);
    expect(quoteZero.estimate.totalDays).toBeNull();
    expect(quoteZero.groups?.riskDisclosure.length).toBeGreaterThan(0);
  });

  it('a_groups_campaign_with_template_variables_is_rejected_at_create', async () => {
    // Deviation (stated per w3-common.md): mapped to the generic
    // VALIDATION_ERROR (400) - no new @wp/contracts error code was added in
    // this unit's scope (out of file ownership).
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    await expect(
      createBroadcast(
        { tenantDb, publishWake: () => {} },
        {
          clientId: tenant.clientId,
          actor: { kind: 'user', userId: randomUUID() },
          idempotencyKey: randomUUID(),
          name: 'groups with vars',
          instanceId: tenant.instanceId,
          audience: { kind: 'groups' },
          message: { kind: 'text', body: 'Hello {{first_name}}!' },
          priority: 'low',
          scheduledAt: null,
        },
      ),
    ).rejects.toThrow(GroupsAudienceTemplateVarsError);

    const rows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaigns WHERE client_id = $1`,
      [tenant.clientId],
    );
    expect(rows.rows[0]?.count).toBe('0');
  });

  it('target_kind_is_derived_from_the_audience_kind', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    await seedWaGroup(pool, {
      clientId: tenant.clientId,
      instanceId: tenant.instanceId,
      sendEnabled: true,
      groupJid: syntheticGroupJid(),
    });

    const groupsDetail = await createBroadcast(
      { tenantDb, publishWake: () => {} },
      {
        clientId: tenant.clientId,
        actor: { kind: 'user', userId: randomUUID() },
        idempotencyKey: randomUUID(),
        name: 'groups campaign',
        instanceId: tenant.instanceId,
        audience: { kind: 'groups' },
        message: { kind: 'text', body: 'Hello group!' },
        priority: 'low',
        scheduledAt: null,
      },
    );
    const groupsRow = await pool.query<{ target_kind: string }>(
      `SELECT target_kind FROM campaigns WHERE id = $1`,
      [groupsDetail.id],
    );
    expect(groupsRow.rows[0]?.target_kind).toBe('groups');

    const contactsDetail = await createBroadcast(
      { tenantDb, publishWake: () => {} },
      {
        clientId: tenant.clientId,
        actor: { kind: 'user', userId: randomUUID() },
        idempotencyKey: randomUUID(),
        name: 'contacts campaign',
        instanceId: tenant.instanceId,
        audience: { kind: 'contacts', tagIds: [tenant.tagId] },
        message: { kind: 'text', body: 'Hello!' },
        priority: 'low',
        scheduledAt: null,
      },
    );
    const contactsRow = await pool.query<{ target_kind: string }>(
      `SELECT target_kind FROM campaigns WHERE id = $1`,
      [contactsDetail.id],
    );
    expect(contactsRow.rows[0]?.target_kind).toBe('contacts');

    // A body carrying `targetKind` is rejected by the strict zod schema at
    // the route layer (createBroadcastInputSchema.strict()) - not exercised
    // here (this unit owns the service, not the route's zod parse), but the
    // service itself never accepts a caller-supplied targetKind: `input`
    // (CreateBroadcastServiceInput) has no such field at all.
  });
});
