import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createExpansionBudget } from './expansion-budget.js';
import { runExpansionBatch, runExpansionToCompletion } from './expansion.worker.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedBroadcastContact,
  seedBroadcastTenant,
  seedBroadcastCampaign,
  statementsFor,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { runSnapshotToCompletion } from './snapshot.worker.js';

/**
 * expansion-scale-c2.integration.test.ts (P23 C2 close-step hardening
 * pass, max-lines sibling split - see expansion-clock-boundary-c2.
 * integration.test.ts for gap (e)):
 *   (g) expansion budget exhaustion storm: 1,000 consecutive held batches
 *       (never opening a transaction - budget is checked before `with
 *       Tenant`) change no row; the first batch after refill proceeds.
 *   (h) a campaign whose recipients span 40 expansion batches keeps the
 *       cursor strictly monotonic and every aggregate counter exact.
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
    applicationName: 'broadcast-expansion-scale-c2-test',
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

describe('broadcast expansion scale edge cases (P23 C2, gaps g/h)', () => {
  it('a_thousand_consecutive_budget_exhausted_batches_change_no_row_and_the_first_batch_after_refill_proceeds', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedBroadcastCampaign(pool, tenant, {
      status: 'snapshotting',
      body: 'Hello!',
    });
    await pool.query('INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)', [
      campaignId,
      tenant.clientId,
    ]);
    for (let i = 0; i < 5; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i);
    }
    await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000 },
      { campaignId, clientId: tenant.clientId },
    );

    let nowMs = 0;
    // `burst` is BOTH the starting balance AND the hard refill ceiling
    // (`Math.min(burst, tokens + refilled)` in `createExpansionBudget`) -
    // no amount of elapsed time can ever push the balance past it. Two
    // batches' worth (1,000 = 2 x `BUDGET_TOKENS_PER_BATCH`) covers exactly
    // what `runExpansionToCompletion` needs below: one call that inserts
    // the 5 rows, then a second that finds the cursor exhausted and
    // completes - both cost 500 tokens regardless of outcome. The storm
    // phase pins `nowMs` at a fixed instant (no elapsed time, hence no
    // refill) for exactly 1,000 calls, then advances it in one jump.
    const budget = createExpansionBudget({
      ratePerSecond: 500,
      burst: 1_000,
      clock: { now: () => nowMs },
    });
    // Drain the starting 1,000 tokens first - `createExpansionBudget`
    // starts at `burst` tokens, so without this the storm loop below would
    // not actually be exhausted from its very first call.
    expect(budget.tryTake(500)).toBe(true);
    expect(budget.tryTake(500)).toBe(true);

    for (let i = 0; i < 1_000; i += 1) {
      const result = await runExpansionBatch(
        { tenantDb, budget },
        { campaignId, clientId: tenant.clientId },
      );
      expect(result).toEqual({ kind: 'held', reason: 'budget' });
    }

    const campaignRow = await pool.query<{ status: string; expand_cursor_recipient_id: string }>(
      `SELECT status, expand_cursor_recipient_id FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(campaignRow.rows[0]?.status).toBe('expanding');
    expect(campaignRow.rows[0]?.expand_cursor_recipient_id).toBe('0');
    const stillPending = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_recipients
        WHERE campaign_id = $1 AND status = 'pending'`,
      [campaignId],
    );
    expect(stillPending.rows[0]?.count).toBe('5');
    const counts = await statementsFor(pool, tenant.clientId);
    expect(counts.inserted).toBe(0);
    expect(counts.refs).toBe(0);

    // 2 seconds at 500 tokens/sec refills exactly 1,000 tokens (the burst
    // ceiling) - exactly the two calls `runExpansionToCompletion` needs.
    nowMs += 2_000;
    const result = await runExpansionToCompletion(
      { tenantDb, budget },
      { campaignId, clientId: tenant.clientId },
    );
    expect(result).toEqual({ kind: 'done' });
    const countsAfter = await statementsFor(pool, tenant.clientId);
    expect(countsAfter.inserted).toBe(5);
    expect(countsAfter.refs).toBe(5);
  });

  it('a_campaign_spanning_40_expansion_batches_keeps_the_cursor_strictly_monotonic_and_counters_exact', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds, { maxBroadcastRecipients: 400 });
    const campaignId = await seedBroadcastCampaign(pool, tenant, {
      status: 'snapshotting',
      body: 'Hello!',
    });
    await pool.query('INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)', [
      campaignId,
      tenant.clientId,
    ]);

    const totalContacts = 400;
    const batchSize = 10;
    const expectedBatches = totalContacts / batchSize;
    for (let i = 0; i < totalContacts; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i);
    }

    const snap = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(snap).toEqual({ kind: 'done', audienceCount: totalContacts });

    let lastCursor = '0';
    let batches = 0;
    for (;;) {
      const result = await runExpansionBatch(
        { tenantDb, budget: unlimitedBudget(), batchSize },
        { campaignId, clientId: tenant.clientId },
      );
      if (result.kind === 'done') break;
      expect(result.kind).toBe('batch');
      if (result.kind === 'batch') {
        expect(result.inserted).toBe(batchSize);
        expect(result.renderFailed).toBe(0);
        // Strictly monotonic: this batch's max recipient id is strictly
        // greater than the previous batch's.
        expect(BigInt(result.maxRecipientId) > BigInt(lastCursor)).toBe(true);
        lastCursor = result.maxRecipientId;
      }
      batches += 1;
    }

    expect(batches).toBe(expectedBatches);
    expect(batches).toBeGreaterThanOrEqual(40);

    const counts = await statementsFor(pool, tenant.clientId);
    expect(counts.inserted).toBe(totalContacts);
    expect(counts.refs).toBe(totalContacts);

    const countersRow = await pool.query<{
      total: number;
      pending: number;
      queued: number;
      failed: number;
    }>(`SELECT total, pending, queued, failed FROM campaign_counters WHERE campaign_id = $1`, [
      campaignId,
    ]);
    expect(countersRow.rows[0]).toEqual({
      total: totalContacts,
      pending: 0,
      queued: totalContacts,
      failed: 0,
    });

    const campaignRow = await pool.query<{ status: string; expand_cursor_recipient_id: string }>(
      `SELECT status, expand_cursor_recipient_id FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(campaignRow.rows[0]?.status).toBe('running');
    expect(campaignRow.rows[0]?.expand_cursor_recipient_id).toBe(lastCursor);

    // No orphan jobs anywhere in this batch run: every message_jobs row has
    // a matching message_job_refs row, and the count matches exactly.
    const orphanCheck = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs j
        WHERE j.client_id = $1 AND j.campaign_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM message_job_refs r
             WHERE r.message_job_id = j.id AND r.client_id = j.client_id
          )`,
      [tenant.clientId, campaignId],
    );
    expect(orphanCheck.rows[0]?.count).toBe('0');
  }, 30_000);
});
