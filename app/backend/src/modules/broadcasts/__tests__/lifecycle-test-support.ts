import { createDwrrSelector } from '@wp/domain';
import type { TenantDb } from '@wp/db';
import { claimAndReserve } from '../../../engine/queue/send-loop-pacing-claim.js';
import { runOneSendLoopIteration, type SendLoopDeps } from '../../../engine/queue/send-loop.js';
import { dispatch } from '../../../engine/queue/dispatch.js';
import { resolveAck } from '../../../engine/queue/result.js';
import { bindQueueMetrics } from '../../../engine/queue/metrics.js';
import { createFakeTransport } from '../../../provider/__test-support__/fake-transport.js';
import { claimOne } from '../../queue/queue.repo.js';
import { runExpansionToCompletion } from '../expansion.worker.js';
import { createExpansionBudget } from '../expansion-budget.js';
import {
  seedExpandingCampaign,
  type SeededBroadcastTenant,
  type TestPool,
} from './broadcasts-test-support.js';

/**
 * lifecycle-test-support.ts (P23 Unit U5, step 6) - shared, non-test fixture
 * machinery for `lifecycle.integration.test.ts` / `lifecycle-pause-resume.
 * integration.test.ts` (max-lines split - no `.test.ts` suffix, same
 * convention as `broadcasts-test-support.ts`).
 */

export const unlimitedBudget = () =>
  createExpansionBudget({
    ratePerSecond: 1_000_000,
    burst: 1_000_000,
    clock: { now: () => Date.now() },
  });

/** `DEFAULT_BAND_WEIGHTS.LOW` - the `priority_rank` campaign jobs are stamped with (default priority `'low'`). */
export const LOW_BAND = 1;

export const noopBookkeeping = async () => ({
  recipientsStamped: 0,
  jobsStamped: 0,
  done: true,
});

export interface QueuedCampaign {
  clientId: string;
  instanceId: string;
  campaignId: string;
}

/** Seeds a tenant + campaign, snapshots and expands it to completion, returning real `queued` `message_jobs` rows. */
export async function queueCampaignJobs(
  pool: TestPool,
  tenantDb: TenantDb,
  keyProvider: Parameters<typeof seedExpandingCampaign>[2],
  probeClientIds: string[],
  count: number,
): Promise<QueuedCampaign> {
  const { tenant, campaignId } = await seedExpandingCampaign(
    pool,
    tenantDb,
    keyProvider,
    probeClientIds,
    count,
  );
  await runExpansionToCompletion(
    { tenantDb, budget: unlimitedBudget(), batchSize: 1_000 },
    { campaignId, clientId: tenant.clientId },
  );
  return { clientId: tenant.clientId, instanceId: tenant.instanceId, campaignId };
}

/** Attempts exactly one claim via the real `claim-jobs.sql` statement - `true` iff a row was claimed. */
export async function tryClaim(
  tenantDb: TenantDb,
  clientId: string,
  instanceId: string,
): Promise<boolean> {
  const claimed = await tenantDb.withTenant(clientId, (tx) =>
    claimOne(
      { clientId, sql: tx },
      {
        instanceId,
        band: LOW_BAND,
        fence: 1,
        workerId: 'lifecycle-test-worker',
        claimExpiryMs: 90_000,
      },
    ),
  );
  return claimed !== undefined;
}

export interface JobRow {
  id: string;
  status: string;
  cancel_reason: string | null;
}

export async function jobRows(
  pool: TestPool,
  clientId: string,
  campaignId: string,
): Promise<JobRow[]> {
  const result = await pool.query<JobRow>(
    `SELECT id, status, cancel_reason FROM message_jobs
      WHERE client_id = $1 AND campaign_id = $2 ORDER BY id`,
    [clientId, campaignId],
  );
  return result.rows;
}

/** Seeds the wallet/pacing rows a real drain needs (same shape as `expansion-drain-demo`'s own setup) and drains up to `count` jobs through the REAL claim + pacing + dispatch + ack path. */
export async function drainThroughPacing(
  pool: TestPool,
  tenantDb: TenantDb,
  clientId: string,
  instanceId: string,
  count: number,
): Promise<void> {
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

  const transport = createFakeTransport();
  for (let i = 0; i < count; i += 1) {
    transport.queueResolve(0, `wamid.lifecycle-drain-${String(i)}`);
  }
  const frozenNow = Date.now();
  const rng = { random: () => 0.5 };
  const deps: SendLoopDeps = {
    clientId,
    instanceId,
    workerId: 'lifecycle-drain-worker',
    fence: 1,
    claimOne: claimAndReserve({ tenantDb, rng, clock: { now: () => frozenNow } }),
    dispatch: (input, d) => dispatch(input, d as never),
    resolveAck: (input, d) => resolveAck(input, d as never),
    resolveFailure: () => {
      throw new Error('resolveFailure should not be reached');
    },
    readMaxAttempts: async () => 5,
    metrics: bindQueueMetrics(),
    rng,
    clock: { now: () => frozenNow },
    dwrr: createDwrrSelector(),
    ctx: { clientId, sql: pool },
    dispatchDeps: { tenantDb, transport, clock: { now: () => frozenNow } },
    resultDeps: { tenantDb, rng },
  };

  for (let i = 0; i < count; i += 1) {
    const result = await runOneSendLoopIteration(deps);
    if (!result.claimed) break;
    await pool.query(`UPDATE pacing_ledger SET next_eligible_at = now() WHERE instance_id = $1`, [
      instanceId,
    ]);
  }
}

export type { SeededBroadcastTenant };
