import { createHash } from 'node:crypto';
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

/**
 * expansion-drain-full-c1fix.integration.test.ts (P23 C1 fix round, unit F2,
 * item 2) - the HONEST version of the phase demo's own claim ("500
 * recipients drained under pacing, zero cap violations"): the SAME setup as
 * `expansion-drain-demo.integration.test.ts` (500 contacts, expansion with a
 * crash + re-run, the fingerprint pre-ack, the deterministic DB-side min-gap
 * reset between iterations), but with NO cancel - drains every one of the
 * 500 recipients and asserts the full set of claims the phase file makes:
 * exact sent count, pacing ledger consumed count, zero jobs left `queued`,
 * a durable `processing` row at every transport call, exact wallet debit
 * rows, and every job carrying a ref.
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
    applicationName: 'broadcast-expansion-drain-full-c1fix-test',
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

describe('broadcast expansion + full drain, no cancel (P23 C1 fix round, item 2)', () => {
  it('a_500_contact_broadcast_drains_to_completion_with_exact_evidence', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      500,
    );

    // Same wallet/pacing/pricing seed as the phase demo - eff daily cap 600.
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
         eff_window_start_local, eff_window_end_local, eff_group_daily_cap
       ) VALUES ($1, $2, 1, 600, 100000, 100000, 15000, 15000, 1, 0, '00:00:00', '23:59:59', 50)`,
      [tenant.instanceId, tenant.clientId],
    );

    // Pre-ack the fan-out fingerprint through the legitimate ack table -
    // never a guard bypass; every other content guard stays fully live.
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

    const queuedAfterExpansion = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs
        WHERE client_id = $1 AND campaign_id = $2 AND status = 'queued'`,
      [tenant.clientId, campaignId],
    );
    expect(queuedAfterExpansion.rows[0]?.count).toBe('500');

    // Every message_jobs row of the campaign has a ref.
    const orphans = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs j
         LEFT JOIN message_job_refs r ON r.message_job_id = j.id AND r.message_job_created_at = j.created_at
        WHERE j.client_id = $1 AND j.campaign_id = $2 AND r.public_id IS NULL`,
      [tenant.clientId, campaignId],
    );
    expect(orphans.rows[0]?.count).toBe('0');

    // Drain through the REAL claim + pacing reserve + dispatch + resolveAck -
    // never the raw claimOne. onSend asserts durable-first: the job row
    // exists with status 'processing' at transport-call time.
    // The probes are collected and awaited before the final assertions (C1
    // re-review note): a fire-and-forget `void` promise could only surface a
    // violation as an unhandled rejection after the test body finished.
    const durableFirstProbes: Promise<void>[] = [];
    const transport = createFakeTransport({
      onSend: (call) => {
        durableFirstProbes.push(
          pool
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
            }),
        );
      },
    });
    for (let i = 0; i < 500; i += 1) {
      transport.queueResolve(0, `wamid.broadcast-drain-full-${String(i)}`);
    }

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
        workerId: 'broadcast-drain-full-worker',
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

    // Drain until the claim returns undefined - no cancel this time.
    for (;;) {
      const result = await runOneSendLoopIteration(buildSendLoopDeps());
      if (!result.claimed) {
        break;
      }
      sentCount += 1;
      // Deterministic DB-side min-gap reset between iterations - the SAME
      // idiom the phase demo uses (next_eligible_at is computed from the
      // DATABASE's own now() inside reserve-pacing.sql, never sped up by the
      // injected clock alone).
      await pool.query(`UPDATE pacing_ledger SET next_eligible_at = now() WHERE instance_id = $1`, [
        tenant.instanceId,
      ]);
    }

    // Every send's durable-first probe must have resolved (and none thrown)
    // before any count is trusted - see the onSend note above.
    expect(durableFirstProbes).toHaveLength(500);
    await Promise.all(durableFirstProbes);
    expect(sentCount).toBe(500);

    const remainingQueued = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs
        WHERE client_id = $1 AND campaign_id = $2 AND status = 'queued'`,
      [tenant.clientId, campaignId],
    );
    expect(remainingQueued.rows[0]?.count).toBe('0');

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
    expect(sentRow.rows[0]?.count).toBe('500');

    const ledgerRow = await pool.query<{ consumed_count: number }>(
      `SELECT consumed_count FROM pacing_ledger WHERE instance_id = $1`,
      [tenant.instanceId],
    );
    expect(ledgerRow.rows[0]?.consumed_count).toBe(500);
    expect(ledgerRow.rows[0]?.consumed_count).toBeLessThanOrEqual(600);

    const walletRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM wallet_ledger WHERE client_id = $1`,
      [tenant.clientId],
    );
    expect(walletRows.rows[0]?.count).toBe('500');

    const refsForCampaign = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs j
         JOIN message_job_refs r ON r.message_job_id = j.id AND r.message_job_created_at = j.created_at
        WHERE j.client_id = $1 AND j.campaign_id = $2`,
      [tenant.clientId, campaignId],
    );
    expect(refsForCampaign.rows[0]?.count).toBe('500');

    // End-to-end proof of the campaign_recipients stamp (result-ack-side-
    // effects.ts#stampCampaignRecipientSent) through the REAL send loop,
    // whose dispatchInput.publicId is job.id, never the ref uuid - the
    // regression this fix round exists for.
    const recipientEvidence = await pool.query<{ sent: string; exact: string }>(
      `SELECT count(*) FILTER (WHERE status = 'sent' AND sent_at IS NOT NULL)::text AS sent,
              count(*) FILTER (WHERE status = 'sent' AND charged_minor = 15)::text AS exact
         FROM campaign_recipients WHERE client_id = $1 AND campaign_id = $2`,
      [tenant.clientId, campaignId],
    );
    expect(recipientEvidence.rows[0]?.sent).toBe('500');
    expect(recipientEvidence.rows[0]?.exact).toBe('500');
  }, 60_000);
});
