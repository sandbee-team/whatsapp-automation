import { randomUUID } from 'node:crypto';
import { createDwrrSelector } from '@wp/domain';
import type { TenantDb } from '@wp/db';
import { claimAndReserve } from '../../../engine/queue/send-loop-pacing-claim.js';
import { runOneSendLoopIteration, type SendLoopDeps } from '../../../engine/queue/send-loop.js';
import { dispatch } from '../../../engine/queue/dispatch.js';
import { resolveAck } from '../../../engine/queue/result.js';
import { bindQueueMetrics } from '../../../engine/queue/metrics.js';
import { createFakeTransport } from '../../../provider/__test-support__/fake-transport.js';
import type { SeededBroadcastTenant, TestPool } from './broadcasts-test-support.js';

/**
 * groups-broadcast-test-helpers.ts (P24 groups-messaging Unit U6, step 9) -
 * shared, non-test fixture machinery for `groups-broadcast.integration.
 * test.ts` + `groups-broadcast-preflight.integration.test.ts` (no
 * `.test.ts` suffix - same tenant-scope-guard seed/cleanup exemption
 * convention as `broadcasts-test-support.ts`).
 */

/** Seeds a `groups` campaign row directly (`seedBroadcastCampaign` only supports `contacts`) - its zero `campaign_counters` row, an empty `groupIds` (match every non-left group on the instance). */
export async function seedGroupsCampaign(
  pool: TestPool,
  tenant: SeededBroadcastTenant,
  body = 'Hello group!',
  status = 'snapshotting',
): Promise<string> {
  const campaignId = randomUUID();
  await pool.query(
    `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message, priority, target_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'low', 'groups')`,
    [
      campaignId,
      tenant.clientId,
      tenant.instanceId,
      status,
      `groups probe campaign ${campaignId}`,
      JSON.stringify({ kind: 'groups' }),
      JSON.stringify({ kind: 'text', body }),
    ],
  );
  await pool.query('INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)', [
    campaignId,
    tenant.clientId,
  ]);
  return campaignId;
}

/** Seeds the wallet/pricing/pacing rows a real drain needs, with the caller's own `effGroupDailyCap` (`instance_pacing_state.eff_group_daily_cap`) - same shape as `lifecycle-test-support.ts#drainThroughPacing`'s setup. */
export async function seedGroupsDrainPacing(
  pool: TestPool,
  clientId: string,
  instanceId: string,
  effGroupDailyCap: number,
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
     ) VALUES ($1, $2, 4, 600, 100000, 100000, 15000, 15000, 1, 0, '00:00:00', '23:59:59', $3)`,
    [instanceId, clientId, effGroupDailyCap],
  );
}

/**
 * Drains up to `maxIterations` send-loop iterations through the REAL claim +
 * pacing + dispatch + ack path - unlike `lifecycle-test-support.ts#
 * drainThroughPacing`, this does NOT stop on the first `claimed: false`
 * (a `GROUP_DAILY_CAP` pacing denial resolves `claimed: false` for THAT
 * iteration - see `send-loop.ts`'s own module doc - but the next iteration's
 * fresh `claimOne` attempt still finds the OTHER still-`queued` group jobs;
 * running enough iterations denies each of them in turn, exactly the shape
 * the test needs to assert on).
 */
export async function drainGroupsThroughPacing(
  pool: TestPool,
  tenantDb: TenantDb,
  clientId: string,
  instanceId: string,
  maxIterations: number,
): Promise<number> {
  const transport = createFakeTransport();
  for (let i = 0; i < maxIterations; i += 1) {
    transport.queueResolve(0, `wamid.groups-drain-${String(i)}`);
  }
  const frozenNow = Date.now();
  const rng = { random: () => 0.5 };
  const deps: SendLoopDeps = {
    clientId,
    instanceId,
    workerId: 'groups-drain-worker',
    fence: 1,
    claimOne: claimAndReserve({ tenantDb, rng, clock: { now: () => frozenNow } }),
    dispatch: (input, d) => dispatch(input, d as never),
    resolveAck: (input, d) => resolveAck(input, d as never),
    resolveFailure: () => {
      throw new Error('resolveFailure should not be reached - groups drain only ack/denies');
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

  let sentCount = 0;
  for (let i = 0; i < maxIterations; i += 1) {
    const result = await runOneSendLoopIteration(deps);
    if (result.claimed) sentCount += 1;
    await pool.query(`UPDATE pacing_ledger SET next_eligible_at = now() WHERE instance_id = $1`, [
      instanceId,
    ]);
  }
  return sentCount;
}
