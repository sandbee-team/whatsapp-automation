import { createHash, randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import { createDwrrSelector, normaliseForFingerprint } from '@wp/domain';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createFakeTransport } from '../../provider/__test-support__/fake-transport.js';
import { runOneSendLoopIteration, type SendLoopDeps } from '../../engine/queue/send-loop.js';
import { claimAndReserve } from '../../engine/queue/send-loop-pacing-claim.js';
import { dispatch } from '../../engine/queue/dispatch.js';
import { resolveAck } from '../../engine/queue/result.js';
import { bindQueueMetrics } from '../../engine/queue/metrics.js';
import { runExpansionToCompletion } from './expansion.worker.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedExpandingCampaign,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { createExpansionBudget } from './expansion-budget.js';
import { cancelBroadcast } from './lifecycle.service.js';

/**
 * expansion-drain-demo.integration.test.ts (P23 Unit U4, step 8's second
 * half) - THE PHASE DEMO: a 500-contact broadcast, expanded with a crash
 * injected mid-expansion and a re-run, drained through the REAL
 * `claimAndReserve` + `dispatch` + `resolveAck`, with a cancel mid-drain
 * enforced purely by the claim predicate's status commit. Split out of
 * `expansion.integration.test.ts` (max-lines cap) - shared seed helpers live
 * in `__tests__/broadcasts-test-support.ts`.
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
    applicationName: 'broadcast-expansion-drain-demo-test',
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

describe('broadcast expansion + drain demo (P23 phase demo)', () => {
  it('a_500_contact_broadcast_drains_under_pacing', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      500,
    );

    // The claim/pacing/wallet path needs wallet_accounts, client_pricing and
    // instance_pacing_state - none of which seedBroadcastTenant seeds (its
    // callers only exercise snapshot/expansion, never the real claim). Same
    // shape as queue-send-tenant-fixture.ts#seedSendTenant, with the cap
    // this demo needs (600) rather than that fixture's generic default.
    await pool.query(
      `INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor)
       VALUES ($1, 1000000, 'active', 100)`,
      [tenant.clientId],
    );
    await pool.query(`INSERT INTO client_pricing (client_id, price_list_key) VALUES ($1, $2)`, [
      tenant.clientId,
      'default_inr',
    ]);
    // eff_gap_min_ms/eff_gap_max_ms at the ABSOLUTE_GAP_MIN_MS floor
    // (15000) - drawGapMs internally clamps to that floor regardless, so
    // this is the minimum legal value. The min-gap wait itself is cleared
    // deterministically between drain iterations below (see that loop's
    // own comment) rather than sped up via the injected clock, because
    // `next_eligible_at` is computed from the DATABASE's own `now()`.
    await pool.query(
      `INSERT INTO instance_pacing_state (
         instance_id, client_id, warmup_tier,
         eff_daily_cap, eff_hourly_cap, eff_new_conv_cap,
         eff_gap_min_ms, eff_gap_max_ms, eff_cold_ratio_max, eff_cold_ratio_floor,
         eff_window_start_local, eff_window_end_local, eff_group_daily_cap
       ) VALUES ($1, $2, 1, 600, 100000, 100000, 15000, 15000, 1, 0, '00:00:00', '23:59:59', 50)`,
      [tenant.instanceId, tenant.clientId],
    );

    // Pre-ack the fingerprint (safe_default's 60/day threshold) - never a
    // guard bypass; every OTHER content guard stays fully live for this drain.
    const fingerprint = createHash('sha256')
      .update(normaliseForFingerprint('Hello!'), 'utf8')
      .digest();
    await pool.query(
      `INSERT INTO content_fingerprints (client_id, local_date, fingerprint, ack_by, ack_at)
       VALUES ($1, (now() AT TIME ZONE 'Asia/Kolkata')::date, $2, gen_random_uuid(), now())`,
      [tenant.clientId, fingerprint],
    );

    const realTenantDb = createTenantDb(pool);
    let calls = 0;
    const crashingTenantDb: TenantDb = {
      async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
        calls += 1;
        if (calls === 2) {
          throw new Error('simulated crash mid-expansion');
        }
        return realTenantDb.withTenant(clientId, fn);
      },
    };

    await expect(
      runExpansionToCompletion(
        { tenantDb: crashingTenantDb, budget: unlimitedBudget(), batchSize: 500 },
        { campaignId, clientId: tenant.clientId },
      ),
    ).rejects.toThrow('simulated crash');

    const rerun = await runExpansionToCompletion(
      { tenantDb: realTenantDb, budget: unlimitedBudget(), batchSize: 500 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(rerun).toEqual({ kind: 'done' });

    const queuedCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs
        WHERE client_id = $1 AND campaign_id = $2 AND status = 'queued'`,
      [tenant.clientId, campaignId],
    );
    expect(queuedCount.rows[0]?.count).toBe('500');

    const refCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_job_refs WHERE client_id = $1`,
      [tenant.clientId],
    );
    expect(refCount.rows[0]?.count).toBe('500');

    // Drain through the REAL claim + pacing reserve (claimAndReserve) +
    // dispatch + resolveAck - never the raw claimOne (which skips pacing
    // entirely and is only appropriate for the non-pacing e2e fixtures).
    const transport = createFakeTransport({
      onSend: (call) => {
        // FakeTransport onSend asserts the job row exists with status
        // 'processing' at call time - durable-first, core invariant 1.
        void pool
          .query<{ status: string }>(
            `SELECT status FROM message_jobs WHERE client_id = $1 AND recipient_jid = $2 ORDER BY id DESC LIMIT 1`,
            [tenant.clientId, call.msg.to],
          )
          .then((row) => {
            if (row.rows[0]?.status !== 'processing') {
              throw new Error(
                `onSend: expected status 'processing', got ${String(row.rows[0]?.status)}`,
              );
            }
          });
      },
    });
    for (let i = 0; i < 500; i += 1) {
      transport.queueResolve(0, `wamid.broadcast-drain-${String(i)}`);
    }

    // A frozen clock - `next_eligible_at` (the min-gap wait) is computed
    // from the DATABASE's own `now()` inside reserve-pacing.sql, not from
    // this injected clock, so freezing it here has no bearing on the gap
    // (see the loop's own comment on how the gap is cleared deterministically
    // between iterations instead).
    const frozenNow = Date.now();
    const dwrr = createDwrrSelector();
    const rng = { random: () => 0.5 };
    const metrics = bindQueueMetrics();
    const clock = { now: () => frozenNow };
    const claimAndReserveFn = claimAndReserve({ tenantDb: realTenantDb, rng, clock });

    function buildSendLoopDeps(): SendLoopDeps {
      return {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        workerId: 'broadcast-drain-worker',
        fence: 1,
        claimOne: claimAndReserveFn,
        dispatch: (input, deps) => dispatch(input, deps as never),
        resolveAck: (input, deps) => resolveAck(input, deps as never),
        resolveFailure: () => {
          throw new Error('resolveFailure should not be reached - every queued send resolves');
        },
        readMaxAttempts: async () => 5,
        metrics,
        rng,
        clock,
        dwrr,
        ctx: { clientId: tenant.clientId, sql: pool },
        dispatchDeps: { tenantDb: realTenantDb, transport, clock },
        resultDeps: { tenantDb: realTenantDb, rng },
      };
    }

    let sentCount = 0;
    let cancelledAt: number | null = null;

    for (let i = 0; i < 500; i += 1) {
      if (i === 100) {
        // Bookkeeping stubbed to a no-op: this demo proves the claim
        // predicate ALONE (the status commit) stops the drain.
        const noopBookkeeping = async () => ({
          recipientsStamped: 0,
          jobsStamped: 0,
          done: true,
        });
        await cancelBroadcast(
          { tenantDb: realTenantDb, publishWake: () => {}, runBookkeeping: noopBookkeeping },
          { kind: 'user', userId: randomUUID() },
          { clientId: tenant.clientId, id: campaignId, reason: 'test' },
        );
        cancelledAt = sentCount;
      }

      const result = await runOneSendLoopIteration(buildSendLoopDeps());
      if (!result.claimed) {
        // The very next claimAndReserve after the cancel commit returns
        // undefined - no more jobs are claimable (the allow-list predicate
        // fails closed on a non-running/expanding campaign).
        break;
      }
      sentCount += 1;
      // `next_eligible_at` is computed from the DATABASE's own `now()`
      // inside reserve-pacing.sql (never from the injected clock - only the
      // window-open/deny-reason JS logic reads `clock`), so the real
      // min-gap floor (15000ms, ABSOLUTE_GAP_MIN_MS) cannot be sped up by
      // advancing the injected clock alone. This directly clears the gap
      // this iteration's own grant just set - simulating that the gap has
      // already elapsed - so the loop's OWN iteration count (not wall-clock
      // time) is what determines how many jobs get drained, exactly like
      // the DWRR fairness e2e test's own frozen-clock recipe. This never
      // relaxes the daily cap, the window, or any other pacing predicate -
      // only the min-gap wait, which this test is not the one proving.
      await pool.query(`UPDATE pacing_ledger SET next_eligible_at = now() WHERE instance_id = $1`, [
        tenant.instanceId,
      ]);
    }

    expect(cancelledAt).not.toBeNull();
    expect(sentCount).toBeLessThan(500);
    expect(sentCount).toBeGreaterThan(0);

    const remainingQueued = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs
        WHERE client_id = $1 AND campaign_id = $2 AND status = 'queued'`,
      [tenant.clientId, campaignId],
    );
    expect(Number(remainingQueued.rows[0]?.count)).toBe(500 - sentCount);

    const failedCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs
        WHERE client_id = $1 AND campaign_id = $2 AND status = 'failed'`,
      [tenant.clientId, campaignId],
    );
    expect(failedCount.rows[0]?.count).toBe('0');

    const sentRow = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs
        WHERE client_id = $1 AND campaign_id = $2 AND status = 'sent'`,
      [tenant.clientId, campaignId],
    );
    expect(Number(sentRow.rows[0]?.count)).toBe(sentCount);
    expect(Number(sentRow.rows[0]?.count)).toBeLessThanOrEqual(600);

    const ledgerRow = await pool.query<{ consumed_count: number }>(
      `SELECT consumed_count FROM pacing_ledger WHERE instance_id = $1`,
      [tenant.instanceId],
    );
    expect(ledgerRow.rows[0]?.consumed_count).toBe(sentCount);

    const walletRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM wallet_ledger WHERE client_id = $1`,
      [tenant.clientId],
    );
    expect(Number(walletRows.rows[0]?.count)).toBe(sentCount);
  });
});
