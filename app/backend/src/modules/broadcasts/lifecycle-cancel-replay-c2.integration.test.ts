import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { claimAndReserve } from '../../engine/queue/send-loop-pacing-claim.js';
import { dispatch } from '../../engine/queue/dispatch.js';
import { resolveAck } from '../../engine/queue/result.js';
import { createFakeTransport } from '../../provider/__test-support__/fake-transport.js';
import { cancelBroadcast } from './lifecycle.service.js';
import { runCancelBookkeepingBatch } from './cancel-bookkeeping.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedExpandingCampaign,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { unlimitedBudget, LOW_BAND, noopBookkeeping } from './__tests__/lifecycle-test-support.js';
import { runExpansionToCompletion } from './expansion.worker.js';

/**
 * lifecycle-cancel-replay-c2.integration.test.ts (P23 C2 close-step
 * hardening pass, max-lines sibling split - see lifecycle-optout-claim-
 * gate-c2.integration.test.ts for gap (b)) - gap (f): replaying the
 * cancel-bookkeeping sweep twice for the same campaign stamps nothing
 * twice and never flips an already-'sent' recipient's job to 'cancelled'.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-lifecycle-cancel-replay-c2-test',
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

describe('broadcast cancel-bookkeeping replay (P23 C2, gap f)', () => {
  it('replaying_cancel_bookkeeping_twice_stamps_nothing_twice_and_never_flips_a_sent_recipient', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      3,
    );
    await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );
    await seedWalletAndPricing(tenant.clientId, tenant.instanceId);

    // Drain ONE job through to 'sent' before the cancel - it must never be
    // flipped to 'cancelled' by any bookkeeping run.
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
        workerId: 'replay-test-worker',
        claimExpiryMs: 90_000,
      },
    );
    expect(claimed).toBeDefined();
    if (!claimed) throw new Error('unreachable');

    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid.replay-1');
    const dispatchResult = await dispatch(
      {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        jobId: claimed.id,
        jobCreatedAt: claimed.createdAt,
        leaseId: claimed.leaseId,
        attempts: claimed.attempts,
        recipientJid: claimed.recipientJid,
        payloadKind: claimed.payloadKind,
        payload: claimed.payload as Record<string, unknown>,
        publicId: randomUUID(),
        fence: 1,
        recipientHash: claimed.recipientHash,
        sendOrigin: claimed.sendOrigin,
        pacingReserve: claimed.pacingReserve,
      },
      { tenantDb, transport, clock: { now: () => Date.now() } },
    );
    await resolveAck(
      {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        jobId: claimed.id,
        jobCreatedAt: claimed.createdAt,
        leaseId: claimed.leaseId,
        attemptNo: dispatchResult.attemptNo,
        publicId: randomUUID(),
        outcome: dispatchResult.sendOutcome ?? { providerMsgId: 'wamid.replay-1' },
        payloadKind: claimed.payloadKind,
        recipientHash: claimed.recipientHash,
        recipientJid: claimed.recipientJid,
      },
      { tenantDb, rng: { random: () => 0.5 } },
    );

    await cancelBroadcast(
      { tenantDb, publishWake: () => {}, runBookkeeping: noopBookkeeping },
      { kind: 'user', userId: randomUUID() },
      { clientId: tenant.clientId, id: campaignId },
    );

    const first = await runCancelBookkeepingBatch(tenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    // 2 of the 3 recipients' jobs are still `queued` at cancel time (the
    // third is already `sent`, no longer `queued`, so stampJobBatch's own
    // WHERE clause excludes it from this count).
    expect(first.jobsStamped).toBe(2);

    const second = await runCancelBookkeepingBatch(tenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    expect(second.recipientsStamped).toBe(0);
    expect(second.jobsStamped).toBe(0);

    // The sent job is untouched by either bookkeeping run.
    const sentJobRow = await pool.query<{ status: string }>(
      `SELECT status FROM message_jobs WHERE id = $1 AND client_id = $2`,
      [claimed.id, tenant.clientId],
    );
    expect(sentJobRow.rows[0]?.status).toBe('sent');

    // Exactly 2 message_jobs rows are 'cancelled' (never a third, never
    // re-stamped by the replay).
    const cancelledCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs
        WHERE client_id = $1 AND campaign_id = $2 AND status = 'cancelled'`,
      [tenant.clientId, campaignId],
    );
    expect(cancelledCount.rows[0]?.count).toBe('2');

    // Exactly one wallet_ledger row still exists (the single sent charge) -
    // the replay never charges or refunds anything.
    expect(await ledgerRowCountFor(tenant.clientId)).toBe(1);
  });
});
