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
import {
  seedGroupsCampaign,
  seedGroupsDrainPacing,
} from './__tests__/groups-broadcast-test-helpers.js';

/**
 * groups-broadcast-timing-c2.integration.test.ts (P24 C2 test-engineer,
 * scope item 8) - split out of `groups-broadcast-c2.integration.test.ts` at
 * the max-lines cap (topic split only): a group disabled between snapshot
 * and expansion, and the local-midnight ledger boundary for
 * `groupSentToday` (Asia/Kolkata vs UTC), constructed via the SAME SQL-side
 * `(now() AT TIME ZONE pacing_timezone)::date` formula `groups-cap-
 * today.sql` itself uses - never an injected fake wall clock (there is
 * none in this path; `preflight-groups.ts`/`groups-cap-today.sql` both
 * call real `now()`), so this stays deterministic regardless of what
 * calendar day the suite runs on.
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
    applicationName: 'groups-broadcast-timing-c2-test',
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

describe('groups broadcast c2 - a group disabled between snapshot and expansion', () => {
  it('a_group_disabled_after_snapshot_still_expands_to_a_job_pinned_not_re_checked_at_expansion', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const group = await seedWaGroup(pool, {
      clientId: tenant.clientId,
      instanceId: tenant.instanceId,
      sendEnabled: true,
    });
    const campaignId = await seedGroupsCampaign(pool, tenant);

    const snap = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000, keyProvider },
      { campaignId, clientId: tenant.clientId },
    );
    expect(snap).toEqual({ kind: 'done', audienceCount: 1 });

    const beforeDisable = await pool.query<{ status: string }>(
      `SELECT status FROM campaign_recipients WHERE campaign_id = $1 AND group_id = $2`,
      [campaignId, group.id],
    );
    expect(beforeDisable.rows[0]?.status).toBe('pending');

    // The group is disabled AFTER the snapshot committed - a real-world
    // race (a group_forbidden hit, or a tenant toggling it off) between
    // snapshot and expansion.
    await pool.query(`UPDATE wa_groups SET send_enabled = false WHERE id = $1`, [group.id]);

    const expansion = await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget(), batchSize: 500 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(expansion).toEqual({ kind: 'done' });

    // Pinned: expansion NEVER re-reads wa_groups.send_enabled - it moves
    // every 'pending' campaign_recipients row to 'queued' + a real job
    // regardless of the group's CURRENT eligibility (only the snapshot
    // batch's eligibility mapping is eligibility-aware). The job is created;
    // it is expected to later fail terminally via the group_forbidden path
    // once a real send is attempted, never silently dropped here.
    const jobs = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs WHERE client_id = $1 AND campaign_id = $2`,
      [tenant.clientId, campaignId],
    );
    expect(jobs.rows[0]?.count).toBe('1');

    const recipientAfter = await pool.query<{ status: string }>(
      `SELECT status FROM campaign_recipients WHERE campaign_id = $1 AND group_id = $2`,
      [campaignId, group.id],
    );
    expect(recipientAfter.rows[0]?.status).toBe('queued');
  });
});

describe('groups broadcast c2 - the local-midnight ledger boundary for groupSentToday', () => {
  it('a_ledger_row_keyed_to_the_instance_local_Asia_Kolkata_date_is_read_even_when_it_differs_from_the_UTC_date', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    for (let i = 0; i < 3; i += 1) {
      await seedWaGroup(pool, {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        sendEnabled: true,
      });
    }
    await seedGroupsDrainPacing(pool, tenant.clientId, tenant.instanceId, 10);
    await pool.query(
      `UPDATE instance_pacing_state SET pacing_timezone = 'Asia/Kolkata' WHERE instance_id = $1`,
      [tenant.instanceId],
    );

    // Seed the ledger row keyed to the SAME expression groups-cap-today.sql
    // itself uses for 'Asia/Kolkata' - this is deterministic regardless of
    // what real calendar day/time the suite runs at, because both this
    // INSERT and the later read evaluate `now()` inside their own
    // statements at nearly the same instant and both derive the local date
    // via the identical AT TIME ZONE expression.
    await pool.query(
      `INSERT INTO pacing_ledger (client_id, instance_id, ledger_date, group_sent_count)
       VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Kolkata')::date, 7)`,
      [tenant.clientId, tenant.instanceId],
    );

    const capRow = await pool.query<{ eff_group_daily_cap: number }>(
      `SELECT eff_group_daily_cap FROM instance_pacing_state WHERE instance_id = $1`,
      [tenant.instanceId],
    );
    expect(capRow.rows[0]?.eff_group_daily_cap).toBe(10);

    const campaignId = await seedGroupsCampaign(pool, tenant, 'Hello group!', 'draft');
    // wallet_accounts AND client_pricing already exist from
    // seedGroupsDrainPacing above - nothing further to seed.

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: randomUUID() },
      { clientId: tenant.clientId, id: campaignId },
    );

    // The preflight reads groupSentToday via the SAME ledger_date formula -
    // it must see the row keyed to the Asia/Kolkata local date, i.e. 7, NOT
    // 0 (which is what it would read if the query (incorrectly) used a
    // bare `now()::date` / UTC date instead of the tenant's own
    // pacing_timezone - reserve-pacing.sql note 3's own documented rule).
    expect(quote.groups?.groupSentToday).toBe(7);
    expect(quote.groups?.groupRemainingToday).toBe(3);
  });

  it('a_decoy_ledger_row_at_a_different_calendar_date_is_never_read_as_todays_count', async () => {
    // A second, narrower proof that isolates the JOIN predicate itself
    // rather than the wall-clock-dependent "which date is today": seed a
    // decoy ledger row at a date that can NEVER be today's Asia/Kolkata
    // local date (10 years in the past, a fixed literal - never derived
    // from `now()`), alongside the real row keyed to TODAY's actual local
    // date (computed once, via the SAME expression the production query
    // uses, and reused for both the seed and this test's own expectation -
    // never asserting a value that depends on which day the suite runs).
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    await seedWaGroup(pool, {
      clientId: tenant.clientId,
      instanceId: tenant.instanceId,
      sendEnabled: true,
    });
    await seedGroupsDrainPacing(pool, tenant.clientId, tenant.instanceId, 10);
    await pool.query(
      `UPDATE instance_pacing_state SET pacing_timezone = 'Asia/Kolkata' WHERE instance_id = $1`,
      [tenant.instanceId],
    );

    const todaysKolkataDate = await pool.query<{ d: string }>(
      `SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`,
    );
    const todayDate = todaysKolkataDate.rows[0]!.d;

    // Decoy row: a fixed past date, never today's, regardless of when this
    // suite runs.
    await pool.query(
      `INSERT INTO pacing_ledger (client_id, instance_id, ledger_date, group_sent_count)
       VALUES ($1, $2, '2016-01-01'::date, 999)`,
      [tenant.clientId, tenant.instanceId],
    );
    // Real row: today's Asia/Kolkata local date.
    await pool.query(
      `INSERT INTO pacing_ledger (client_id, instance_id, ledger_date, group_sent_count)
       VALUES ($1, $2, $3::date, 5)`,
      [tenant.clientId, tenant.instanceId, todayDate],
    );

    const campaignId = await seedGroupsCampaign(pool, tenant, 'Hello group!', 'draft');
    // wallet_accounts AND client_pricing already exist from
    // seedGroupsDrainPacing above - nothing further to seed.

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: randomUUID() },
      { clientId: tenant.clientId, id: campaignId },
    );

    // The decoy's 999 must never leak through - only today's real
    // Asia/Kolkata-dated row (5) is read.
    expect(quote.groups?.groupSentToday).toBe(5);
    expect(quote.groups?.groupSentToday).not.toBe(999);
  });
});
