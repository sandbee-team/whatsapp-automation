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
 * lifecycle-money-boundary-c2.integration.test.ts (P23 C2 close-step
 * hardening pass, max-lines sibling split of lifecycle-money-and-replay-c2 -
 * see lifecycle-replay-c2.integration.test.ts for gaps (b)/(f)) - gap (a):
 * money at the cancel boundary. A job CLAIMED before the cancel commit and
 * RESOLVED after it is charged exactly once; the wallet ledger delta after
 * the commit equals exactly that one charge, and nothing claimed after the
 * commit is ever charged.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-lifecycle-money-boundary-c2-test',
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

async function seedWalletAndPricing(
  clientId: string,
  instanceId: string,
  balanceMinor = 1_000_000,
): Promise<void> {
  await pool.query(
    `INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor)
     VALUES ($1, $2, 'active', 100)`,
    [clientId, balanceMinor],
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

describe('broadcast money-at-cancel-boundary (P23 C2, gap a)', () => {
  it('a_job_claimed_before_cancel_commits_and_resolved_after_is_charged_exactly_once', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      2,
    );
    await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );
    await seedWalletAndPricing(tenant.clientId, tenant.instanceId);

    // Claim exactly ONE job (of the two queued) BEFORE the cancel commits.
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
        workerId: 'money-boundary-test-worker',
        claimExpiryMs: 90_000,
      },
    );
    expect(claimed).toBeDefined();
    if (!claimed) throw new Error('unreachable');

    // The cancel commits WHILE this job is still `processing` (in flight) -
    // cancel-bookkeeping only ever touches `queued` rows (cancel-bookkeeping.
    // ts's own `stampJobBatch`: `WHERE status = 'queued'`), so the claimed,
    // in-flight job is untouched by the commit or by bookkeeping.
    await cancelBroadcast(
      { tenantDb, publishWake: () => {}, runBookkeeping: noopBookkeeping },
      { kind: 'user', userId: randomUUID() },
      { clientId: tenant.clientId, id: campaignId },
    );

    // The very next claim attempt (the second recipient's job, still
    // `queued`) sees zero rows - the predicate stopped it immediately.
    const secondClaim = await claimAndReserve({
      tenantDb,
      rng: { random: () => 0.5 },
      clock: { now: () => Date.now() },
    })(
      { clientId: tenant.clientId, sql: pool },
      {
        instanceId: tenant.instanceId,
        band: LOW_BAND,
        fence: 1,
        workerId: 'money-boundary-test-worker-2',
        claimExpiryMs: 90_000,
      },
    );
    expect(secondClaim).toBeUndefined();

    // The bookkeeping batch now runs (as cancelBroadcast's own call already
    // did via runBookkeeping: noopBookkeeping above - run the REAL one here
    // to stamp the still-queued second recipient/job cancelled).
    await runCancelBookkeepingBatch(tenantDb, { clientId: tenant.clientId, campaignId });

    // The in-flight (already-claimed) job is legitimately resolved AFTER
    // the cancel commit - this is the honest, expected charge (invariant:
    // an in-flight send that already left dispatch is not un-sent by a
    // cancel arriving concurrently).
    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid.money-boundary-1');
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
    expect(dispatchResult.outcome).toBe('settled');

    await resolveAck(
      {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        jobId: claimed.id,
        jobCreatedAt: claimed.createdAt,
        leaseId: claimed.leaseId,
        attemptNo: dispatchResult.attemptNo,
        publicId: randomUUID(),
        outcome: dispatchResult.sendOutcome ?? { providerMsgId: 'wamid.money-boundary-1' },
        payloadKind: claimed.payloadKind,
        recipientHash: claimed.recipientHash,
        recipientJid: claimed.recipientJid,
      },
      { tenantDb, rng: { random: () => 0.5 } },
    );

    // Exactly one wallet_ledger row for this client, and its delta is
    // exactly the one charge (a negative debit) - nothing claimed after the
    // cancel commit is charged, and nothing double-charges the in-flight one.
    expect(await ledgerRowCountFor(tenant.clientId)).toBe(1);
    const ledgerRow = await pool.query<{ kind: string; amount_minor: string }>(
      `SELECT kind, amount_minor FROM wallet_ledger WHERE client_id = $1`,
      [tenant.clientId],
    );
    const delta = Number(ledgerRow.rows[0]?.amount_minor ?? 0);
    expect(delta).toBeLessThan(0);
    expect(ledgerRow.rows[0]?.kind).toBe('debit_send');

    // The job that was claimed and resolved is 'sent', never touched by
    // cancel bookkeeping (it was never 'queued' when bookkeeping ran).
    const jobRow = await pool.query<{ status: string }>(
      `SELECT status FROM message_jobs WHERE id = $1 AND client_id = $2`,
      [claimed.id, tenant.clientId],
    );
    expect(jobRow.rows[0]?.status).toBe('sent');
  });
});
