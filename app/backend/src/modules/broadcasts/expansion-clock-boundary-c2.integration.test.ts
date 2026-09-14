import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createExpansionBudget } from './expansion-budget.js';
import { runExpansionToCompletion } from './expansion.worker.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedBroadcastContact,
  seedBroadcastTenant,
  seedBroadcastCampaign,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { runSnapshotToCompletion } from './snapshot.worker.js';
import { tryClaim } from './__tests__/lifecycle-test-support.js';

/**
 * expansion-clock-boundary-c2.integration.test.ts (P23 C2 close-step
 * hardening pass, max-lines sibling split - see expansion-scale-c2.
 * integration.test.ts for gaps (g)/(h)) - gap (e): clock boundaries. A
 * campaign `scheduled_at` bound EXACTLY at "now" is claimable
 * (claim-jobs.sql's `<= now()`, never `< now()`), and the SAME
 * `timestamptz` instant survives the snapshot->expand->message_jobs round
 * trip byte-exact (no truncation/timezone drift).
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
    applicationName: 'broadcast-expansion-clock-boundary-c2-test',
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

describe('broadcast expansion clock boundary edge cases (P23 C2, gap e)', () => {
  it('a_scheduled_at_exactly_equal_to_now_is_claimable_and_the_exact_instant_survives_the_round_trip', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedBroadcastCampaign(pool, tenant, {
      status: 'snapshotting',
      body: 'Hello!',
    });
    await pool.query('INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)', [
      campaignId,
      tenant.clientId,
    ]);
    await seedBroadcastContact(pool, keyProvider, tenant, 0);
    await pool.query(
      `INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor)
       VALUES ($1, 1000000, 'active', 100)`,
      [tenant.clientId],
    );

    await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000 },
      { campaignId, clientId: tenant.clientId },
    );

    // Bind `scheduled_at` to the DATABASE's own `now()` (never a JS Date -
    // this is exactly the precision-hazard class the carried P21 note
    // warns about: a JS `Date` is millisecond-precision, Postgres `now()`
    // is microsecond-precision). Read it back to get the exact instant
    // this instance is testing against.
    const scheduledAtRow = await pool.query<{ scheduled_at: Date }>(
      `UPDATE campaigns SET scheduled_at = now() WHERE id = $1 RETURNING scheduled_at`,
      [campaignId],
    );
    const exactInstant = scheduledAtRow.rows[0]?.scheduled_at;
    if (!exactInstant) throw new Error('unreachable');

    await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );

    const jobRow = await pool.query<{ scheduled_at: Date; next_attempt_at: Date }>(
      `SELECT scheduled_at, next_attempt_at FROM message_jobs
        WHERE client_id = $1 AND campaign_id = $2`,
      [tenant.clientId, campaignId],
    );
    expect(jobRow.rows).toHaveLength(1);
    // Exact microsecond-precision equality - never a bound, never a
    // tolerance window.
    expect(jobRow.rows[0]?.scheduled_at.getTime()).toBe(exactInstant.getTime());
    expect(jobRow.rows[0]?.next_attempt_at.getTime()).toBe(exactInstant.getTime());

    // claim-jobs.sql's own predicate is `<= now()` (never `< now()`) - an
    // instant exactly equal to the current DB now() is claimable, not
    // stranded one tick behind.
    expect(await tryClaim(tenantDb, tenant.clientId, tenant.instanceId)).toBe(true);
  });

  it('a_scheduled_at_strictly_in_the_future_is_not_yet_claimable_even_though_it_is_a_timestamptz_not_a_date', async () => {
    // NOT a 1-microsecond margin: that would make this test's outcome
    // depend on real wall-clock elapsed between the UPDATE and the claim
    // attempt (ambient timing - banned by core-invariants). A comfortably
    // future, fixed instant proves the SAME predicate (`scheduled_at <=
    // now()`) deterministically instead.
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedBroadcastCampaign(pool, tenant, {
      status: 'snapshotting',
      body: 'Hello!',
    });
    await pool.query('INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)', [
      campaignId,
      tenant.clientId,
    ]);
    await seedBroadcastContact(pool, keyProvider, tenant, 0);
    await pool.query(
      `INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor)
       VALUES ($1, 1000000, 'active', 100)`,
      [tenant.clientId],
    );

    await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000 },
      { campaignId, clientId: tenant.clientId },
    );
    await pool.query(
      `UPDATE campaigns SET scheduled_at = now() + interval '1 hour' WHERE id = $1`,
      [campaignId],
    );

    await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );

    expect(await tryClaim(tenantDb, tenant.clientId, tenant.instanceId)).toBe(false);
  });
});
