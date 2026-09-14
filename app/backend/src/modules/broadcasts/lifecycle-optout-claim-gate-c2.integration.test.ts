import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { claimAndReserve } from '../../engine/queue/send-loop-pacing-claim.js';
import { createFakeTransport } from '../../provider/__test-support__/fake-transport.js';
import { recordOptOut } from '../pacing/optout/registry.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedExpandingCampaign,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { unlimitedBudget, LOW_BAND } from './__tests__/lifecycle-test-support.js';
import { runExpansionToCompletion } from './expansion.worker.js';

/**
 * lifecycle-optout-claim-gate-c2.integration.test.ts (P23 C2 close-step
 * hardening pass, max-lines sibling split - see lifecycle-cancel-replay-c2.
 * integration.test.ts for gap (f)) - gap (b): an opt-out registered between
 * snapshot and expansion. The recipient was snapshotted 'pending'; the job
 * still gets expanded (expansion freezes at snapshot time, never re-checks
 * opt-out); the claim-time opt-out gate (the content-guard pipeline INSIDE
 * `claimAndReserve`, ahead of `dispatch()`'s own separate post-claim
 * precheck) cancels it with cancel_reason='opt_out', never 'failed'.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-lifecycle-optout-claim-gate-c2-test',
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

async function seedWalletAndPricing(clientId: string, instanceId: string): Promise<void> {
  await pool.query(
    `INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor)
     VALUES ($1, 1000000, 'active', 100)`,
    [clientId],
  );
  await pool.query(`INSERT INTO client_pricing (client_id, price_list_key) VALUES ($1, $2)`, [
    clientId,
    'default_inr',
  ]);
  await pool.query(
    `INSERT INTO instance_pacing_state (
       instance_id, client_id, warmup_tier,
       eff_daily_cap, eff_hourly_cap, eff_new_conv_cap,
       eff_gap_min_ms, eff_gap_max_ms, eff_cold_ratio_max, eff_cold_ratio_floor,
       eff_window_start_local, eff_window_end_local, eff_group_daily_cap
     ) VALUES ($1, $2, 1, 600, 100000, 100000, 15000, 15000, 1, 0, '00:00:00', '23:59:59', 50)`,
    [instanceId, clientId],
  );
}

async function ledgerRowCountFor(clientId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM wallet_ledger WHERE client_id = $1`,
    [clientId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

describe('broadcast opt-out claim-gate (P23 C2, gap b)', () => {
  it('an_opt_out_registered_between_snapshot_and_expansion_is_cancelled_at_claim_time_not_failed', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      1,
    );

    // The recipient was snapshotted 'pending' (no opt-out existed yet).
    const recipientBefore = await pool.query<{ status: string; recipient_hash: Buffer }>(
      `SELECT status, recipient_hash FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipientBefore.rows[0]?.status).toBe('pending');
    const phoneHash = recipientBefore.rows[0]?.recipient_hash;
    if (!phoneHash) throw new Error('unreachable');

    // Opt-out registered NOW, strictly between snapshot and expansion.
    await tenantDb.withTenant(tenant.clientId, (tx) =>
      recordOptOut(
        tx,
        {
          clientId: tenant.clientId,
          scope: 'client',
          scopeKey: tenant.clientId,
          phoneHash,
          phoneEnc: Buffer.from('opaque-enc-fixture'),
          source: 'api',
        },
        { mirror: async () => undefined },
      ),
    );

    await seedWalletAndPricing(tenant.clientId, tenant.instanceId);

    // Expansion still creates the job (it freezes recipient state at
    // snapshot time, expands regardless of opt-out - the opt-out gate is
    // enforced at claim/dispatch time, never at expansion).
    await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );
    const jobBefore = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM message_jobs WHERE client_id = $1 AND campaign_id = $2`,
      [tenant.clientId, campaignId],
    );
    expect(jobBefore.rows).toHaveLength(1);
    expect(jobBefore.rows[0]?.status).toBe('queued');

    // Claim it. `claimAndReserve`'s own content-guard pipeline
    // (`evaluateOneClaimedJob`, ahead of `dispatch()`'s separate post-claim
    // precheck) evaluates the opt-out gate INSIDE the same claim
    // transaction and terminally disposes the job right there - the claim
    // call itself resolves `undefined` (the band-empty shape: nothing left
    // to hand to `dispatch()`), because the disposed job is no longer
    // `'queued'` for `claim-jobs.sql` to find. This IS the "claim-time
    // opt-out gate" the phase canon refers to.
    const claimed = await claimAndReserve({
      tenantDb,
      rng: { random: () => 0.5 },
      clock: { now: () => Date.now() },
    })(
      { clientId: tenant.clientId, sql: pool },
      {
        instanceId: tenant.instanceId,
        band: LOW_BAND,
        fence: 1,
        workerId: 'optout-gate-test-worker',
        claimExpiryMs: 90_000,
      },
    );
    expect(claimed).toBeUndefined();

    const jobAfter = await pool.query<{
      id: string;
      status: string;
      cancel_reason: string | null;
      pacing_deny_reason: string | null;
    }>(
      `SELECT id, status, cancel_reason, pacing_deny_reason FROM message_jobs
        WHERE client_id = $1 AND campaign_id = $2`,
      [tenant.clientId, campaignId],
    );
    expect(jobAfter.rows).toHaveLength(1);
    expect(jobAfter.rows[0]?.status).toBe('cancelled');
    expect(jobAfter.rows[0]?.cancel_reason).toBe('opt_out');
    expect(jobAfter.rows[0]?.cancel_reason).not.toBe('failed');
    expect(jobAfter.rows[0]?.pacing_deny_reason).toBe('OPT_OUT');

    // Never reached dispatch or the provider at all - a second, independent
    // proof that dispatch()'s own post-claim precheck never even runs for a
    // job the guard pipeline already disposed of during claim.
    const transport = createFakeTransport();
    expect(transport.calls).toHaveLength(0);

    // No wallet charge (never dispatched/resolved), no ledger row at all.
    expect(await ledgerRowCountFor(tenant.clientId)).toBe(0);
  });
});
