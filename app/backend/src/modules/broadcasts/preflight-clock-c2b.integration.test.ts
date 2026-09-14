import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { preflightBroadcast } from './preflight.service.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedBroadcastCampaign,
  seedBroadcastContact,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { insertBucket, readLimits, seedFullTenant } from './__tests__/preflight-edge-support.js';

/**
 * preflight-clock-c2b.integration.test.ts (P23a C2b hardening pass) -
 * residual clock-boundary angles `preflight-edge.integration.test.ts` does
 * not cover: `sentToday`/`totalDays` follow the INSTANCE's own local date
 * (never `now()::date` in Node), the 24h window boundary is strict
 * (`hour_bucket > now() - interval '24 hours'`, never `>=`), and
 * `estimate.finishAt` lands on the exact day-granular offset the spillover
 * formula predicts.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-preflight-clock-c2b-test',
  });
  tenantDb = createTenantDb(pool);
  keyProvider = buildBroadcastsKeyProvider();
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupBroadcastProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('preflightBroadcast clock-boundary edge cases (P23a C2b)', () => {
  it('senttoday_follows_the_instances_local_asia_kolkata_date_not_a_utc_today', async () => {
    const tenant = await seedFullTenant(pool, probeClientIds);
    const limits = await readLimits(pool, tenant);

    // instance_pacing_state.pacing_timezone defaults to 'Asia/Kolkata'
    // (migration 0030) - confirm that is what is actually seeded, never
    // assume it.
    const tz = await pool.query<{ pacing_timezone: string }>(
      `SELECT pacing_timezone FROM instance_pacing_state WHERE instance_id = $1 AND client_id = $2`,
      [tenant.instanceId, tenant.clientId],
    );
    expect(tz.rows[0]?.pacing_timezone).toBe('Asia/Kolkata');

    const effDailyCap = 600; // seedFullTenant -> seedPreflightPacingState default
    await pool.query(
      `INSERT INTO pacing_ledger (client_id, instance_id, ledger_date, consumed_count)
       VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Kolkata')::date, $3)`,
      [tenant.clientId, tenant.instanceId, effDailyCap - 1],
    );
    // Yesterday's (local) row is fully consumed - must never be read as today.
    await pool.query(
      `INSERT INTO pacing_ledger (client_id, instance_id, ledger_date, consumed_count)
       VALUES ($1, $2, ((now() AT TIME ZONE 'Asia/Kolkata')::date - 1), $3)`,
      [tenant.clientId, tenant.instanceId, effDailyCap],
    );

    // 3 billable recipients, none deferred, none skipped.
    for (let i = 0; i < 3; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i);
    }
    const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'draft', body: 'Hi!' });

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: campaignId },
    );

    expect(quote.account.sentToday).toBe(effDailyCap - 1);
    expect(quote.account.remainingToday).toBe(1);
    expect(quote.billable.count).toBe(3);
    expect(quote.estimate.totalDays).toBe(2);
    void limits;
  });

  it('a_bucket_exactly_at_the_24h_boundary_after_truncation_counts_for_7d_only_not_24h', async () => {
    const tenant = await seedFullTenant(pool, probeClientIds);
    // `safe_default` (the fixture's normal profile) has
    // `per_recipient_24h === per_recipient_7d === 3`, which makes this
    // boundary untestable in isolation (a bucket AT the 24h limit is always
    // also AT the 7d limit). Switch this instance to `conservative`
    // (`per_recipient_24h: 1, per_recipient_7d: 3` - read back from the DB
    // below, never hard-coded) so the two thresholds genuinely differ.
    await pool.query(
      `UPDATE instance_pacing_state SET profile_key = 'conservative'
        WHERE instance_id = $1 AND client_id = $2`,
      [tenant.instanceId, tenant.clientId],
    );
    const limits = await readLimits(pool, tenant);
    expect(limits.perRecipient24h).toBe(1);
    expect(limits.perRecipient7d).toBe(3);
    const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'draft', body: 'Hi!' });

    const contact = await seedBroadcastContact(pool, keyProvider, tenant, 0);
    // `insertBucket`'s `hoursAgo` truncates to the hour BEFORE offsetting, so
    // `hoursAgo: 24` lands the bucket at exactly `date_trunc('hour', now() -
    // 24h)` - strictly OLDER than `now() - interval '24 hours'` (the 24h
    // predicate is `hour_bucket > now() - interval '24 hours'`, so a bucket
    // AT that instant, truncated backward in time, fails it) but well within
    // the 7d predicate (`hour_bucket > now() - interval '7 days'`).
    await insertBucket(pool, tenant.clientId, contact.phoneHash, limits.perRecipient24h, 24);

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: campaignId },
    );

    // Not deferred by the 24h check (the bucket falls outside that window),
    // and the 7d sum (1, well under the 7d limit of 3) does not trip the 7d
    // predicate either.
    expect(quote.audience.matched).toBe(1);
    expect(quote.alreadyMessaged.deferred).toBe(0);
    expect(quote.billable.count).toBe(1);
  });

  it('finishat_lands_on_the_exact_totaldays_minus_one_day_offset_from_the_quote_moment', async () => {
    const tenant = await seedFullTenant(pool, probeClientIds);
    const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'draft', body: 'Hi!' });

    // Force spillover: effDailyCap 600, sentToday 590 (remainingToday 10),
    // 25 billable recipients -> totalDays = 1 + ceil((25-10)/600) = 2.
    await pool.query(
      `INSERT INTO pacing_ledger (client_id, instance_id, ledger_date, consumed_count)
       VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Kolkata')::date, 590)`,
      [tenant.clientId, tenant.instanceId],
    );
    for (let i = 0; i < 25; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i);
    }

    const before = Date.now();
    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: campaignId },
    );
    const after = Date.now();

    expect(quote.billable.count).toBe(25);
    expect(quote.estimate.totalDays).toBe(2);
    expect(quote.estimate.finishAt).not.toBeNull();
    const finishAt = new Date(quote.estimate.finishAt!).getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;
    // The service does not accept an injected clock (`now: new Date()` is
    // hardcoded in preflight.service.ts) - bound `finishAt` against the
    // test's own wall-clock window (before/after the call), never against a
    // sampled margin: `finishAt` must equal `quoteMoment + 1 day` for SOME
    // `quoteMoment` in [before, after].
    expect(finishAt).toBeGreaterThanOrEqual(before + oneDayMs);
    expect(finishAt).toBeLessThanOrEqual(after + oneDayMs);
  });
});
