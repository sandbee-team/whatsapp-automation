import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createExpansionBudget } from './expansion-budget.js';
import { runExpansionBatch, runExpansionToCompletion } from './expansion.worker.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedExpandingCampaign,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';

/**
 * expansion-counters-c1fix.integration.test.ts (P23 C1 fix round, unit F2,
 * item 1) - sibling of `expansion.integration.test.ts` (at the 300-line cap)
 * asserting EXACT `campaign_counters` values after a replay and after a
 * crash-resume expansion, over the SAME two scenarios that file's
 * `expansion_replay_creates_no_job_without_a_ref` and
 * `campaign_expansion_is_idempotent_across_a_crash` already prove for
 * `message_jobs`/`message_job_refs`. Before this fix, `bumpExpansionCounters`
 * drove its pending/queued deltas from the `ref` CTE's insert count, which
 * under-counts on every replay (a replayed recipient's dedupe conflict
 * inserts 0 new refs, yet the recipient IS re-stamped `queued` by the `upd`
 * CTE) - `queued` stayed 0 and `pending` never drained on any resumed batch.
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

interface CountersRow {
  total: number;
  pending: number;
  queued: number;
  failed: number;
}

async function readCounters(campaignId: string): Promise<CountersRow> {
  const result = await pool.query<CountersRow>(
    `SELECT total, pending, queued, failed FROM campaign_counters WHERE campaign_id = $1`,
    [campaignId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('expansion-counters-c1fix: campaign_counters row missing');
  return row;
}

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-expansion-counters-c1fix-test',
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

describe('broadcast expansion counters (P23 C1 fix round, item 1)', () => {
  it('a_replayed_batch_leaves_campaign_counters_exact_not_double_or_zero_queued', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      50,
    );

    const first = await runExpansionBatch(
      { tenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );
    expect(first.kind).toBe('batch');

    expect(await readCounters(campaignId)).toEqual({
      total: 50,
      pending: 0,
      queued: 50,
      failed: 0,
    });

    // Replay: the SAME shape as expansion.integration.test.ts's own
    // `expansion_replay_creates_no_job_without_a_ref` - undo the FIRST
    // batch's entire visible effect (cursor, recipient status AND the
    // counters bump it made in the same transaction), simulating "that
    // transaction never committed" faithfully rather than partially. Re-run
    // the same batch: it is now the ONE commit for these 50 recipients.
    await pool.query('UPDATE campaigns SET expand_cursor_recipient_id = 0 WHERE id = $1', [
      campaignId,
    ]);
    await pool.query(
      `UPDATE campaign_recipients SET status = 'pending', queued_at = NULL
        WHERE campaign_id = $1`,
      [campaignId],
    );
    await pool.query(
      `UPDATE campaign_counters SET pending = 50, queued = 0 WHERE campaign_id = $1`,
      [campaignId],
    );
    const replay = await runExpansionBatch(
      { tenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );
    expect(replay.kind).toBe('batch');

    // Exact, not merely non-zero: the replay's `ref` insert count is 0 (every
    // dedupe_key already exists - the dedupe guard fired), but every
    // recipient IS re-stamped `queued` by the `upd` CTE, so the counters
    // must reach the SAME final state as the first run's - never left at
    // `queued: 0` (the confirmed bug: driving the delta from `ref`'s insert
    // count, which is 0 on a pure replay).
    expect(await readCounters(campaignId)).toEqual({
      total: 50,
      pending: 0,
      queued: 50,
      failed: 0,
    });
  });

  it('campaign_counters_are_exact_after_a_crash_resume_expansion', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      1_200,
    );

    const realTenantDb = createTenantDb(pool);
    let calls = 0;
    const crashingTenantDb: TenantDb = {
      async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
        calls += 1;
        if (calls > 1) {
          throw new Error('simulated crash after first committed expansion batch');
        }
        return realTenantDb.withTenant(clientId, fn);
      },
    };

    await expect(
      runExpansionToCompletion(
        { tenantDb: crashingTenantDb, budget: unlimitedBudget() },
        { campaignId, clientId: tenant.clientId },
      ),
    ).rejects.toThrow('simulated crash');

    // After the crash: exactly one committed batch (500) is stamped queued;
    // the rest are still pending.
    expect(await readCounters(campaignId)).toEqual({
      total: 1_200,
      pending: 700,
      queued: 500,
      failed: 0,
    });

    const budget = unlimitedBudget();
    for (;;) {
      const result = await runExpansionBatch(
        { tenantDb: realTenantDb, budget },
        { campaignId, clientId: tenant.clientId },
      );
      if (result.kind === 'done') break;
    }

    // Full resume completes: every recipient queued, none left pending, no
    // double-count from the re-run of the already-committed first batch
    // (its recipients are no longer `pending`, so the resumed run's own
    // keyset read never re-selects them).
    expect(await readCounters(campaignId)).toEqual({
      total: 1_200,
      pending: 0,
      queued: 1_200,
      failed: 0,
    });
  }, 30_000);
});
