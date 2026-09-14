import type { TenantDb, TenantQueryable } from '@wp/db';
import type { HealthBand, Layers } from '@wp/domain';
import { notify } from '../../modules/notifications/index.js';
import { updatePacingConfig, type PacingConfigQueryable } from './config-service.js';
import { decideWarmupAction } from './warmup-decision.js';
import { elapsedLocalDays, warmupTierLayer, type DueInstanceRow } from './warmup-evaluator-row.js';
import {
  readSystemProfileLayer,
  type PacingEvaluatorPublish,
  type WarmupMetrics,
} from './warmup-evaluator.js';

/**
 * warmup-evaluator-apply.ts (P17 U6, step 5 - max-lines split of
 * `warmup-evaluator.ts`, same established idiom as `session-worker-
 * discovery-wiring.ts`/`session-cost-feedback-timer.ts`) - `evaluateOneInstance`,
 * the per-instance decide-then-apply body `runOnePacingEvaluatorSweep` calls
 * once per due row. No logic change from the pre-split version beyond the
 * P17 U6 addition documented on the notify() call below.
 */

export interface EvaluateOneInstanceDeps {
  pool: PacingConfigQueryable;
  tenantDb: TenantDb;
  clock: { now(): number };
  publish: PacingEvaluatorPublish;
}

async function hasRecentHardSignal(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<boolean> {
  const result = await tx.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM pacing_events
        WHERE client_id = $1 AND instance_id = $2 AND kind = 'hard_signal_pause'
          AND created_at > now() - interval '24 hours'
     ) AS exists`,
    [clientId, instanceId],
  );
  return result.rows[0]?.exists === true;
}

/**
 * A degraded rollback is due only if no `WARMUP_ROLLBACK` event exists after
 * the episode's start anchor - the most recent `BAND_CHANGE` event whose
 * `to_value` shows entry into `degraded`. See `warmup-evaluator.ts`'s own
 * (pre-split) history note for the full FIX ROUND MAJOR 4 rationale - carried
 * here unchanged.
 */
async function isDegradedRollbackDue(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<boolean> {
  const anchorResult = await tx.query<{ anchor: Date | null }>(
    `SELECT MAX(created_at) AS anchor FROM pacing_events
      WHERE client_id = $1 AND instance_id = $2 AND kind = 'BAND_CHANGE'
        AND to_value->>'band' = 'degraded'`,
    [clientId, instanceId],
  );
  const anchor = anchorResult.rows[0]?.anchor;
  if (!anchor) return false;

  const rollbackResult = await tx.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM pacing_events
        WHERE client_id = $1 AND instance_id = $2 AND kind = 'WARMUP_ROLLBACK'
          AND created_at > $3
     ) AS exists`,
    [clientId, instanceId, anchor],
  );
  return rollbackResult.rows[0]?.exists !== true;
}

/** Runs the decide-then-apply body for ONE due instance row - see module doc. */
export async function evaluateOneInstance(
  deps: EvaluateOneInstanceDeps,
  row: DueInstanceRow,
  metrics: WarmupMetrics,
): Promise<void> {
  const nowMs = deps.clock.now();
  const elapsedDays = row.warmup_started_at
    ? elapsedLocalDays(row.warmup_started_at.getTime(), nowMs, row.pacing_timezone)
    : 0;

  const { hasRecentHardRestrictionSignal, degradedRollbackDueForEpisode, systemProfile } =
    await deps.tenantDb.withTenant(row.client_id, async (tx) => ({
      hasRecentHardRestrictionSignal: await hasRecentHardSignal(tx, row.client_id, row.instance_id),
      degradedRollbackDueForEpisode:
        row.health_band === 'degraded'
          ? await isDegradedRollbackDue(tx, row.client_id, row.instance_id)
          : false,
      systemProfile: await readSystemProfileLayer(tx, row.client_id, row.instance_id),
    }));

  const decision = decideWarmupAction({
    warmupTier: row.warmup_tier,
    warmupStartedAtMs: row.warmup_started_at ? row.warmup_started_at.getTime() : null,
    healthBand: row.health_band,
    hasRecentHardRestrictionSignal,
    isPaused: row.health_state === 'paused',
    degradedRollbackDueForEpisode,
    elapsedDays,
  });

  if (decision.action === 'hold') return;

  const layers: Layers = {
    systemProfile,
    warmupTier: warmupTierLayer(decision.toTier),
    healthBand: row.health_band as HealthBand,
  };

  const result = await updatePacingConfig({
    sql: deps.pool,
    clientId: row.client_id,
    instanceId: row.instance_id,
    kind: 'warmup_tier',
    reason: `warmup evaluator: ${decision.action}`,
    layers,
    clock: deps.clock,
    expectedFromWarmupTier: row.warmup_tier,
    toWarmupTier: decision.toTier,
    reasonCodes: decision.reasonCodes,
    evidence: decision.evidence,
  });

  metrics.tierChange(decision.action);

  // P17 U6 (step 5) - warmup_tier_changed: sse-only, non-mandatory kind
  // (kinds.ts). Runs on `deps.pool` - the SAME queryable
  // `applyWarmupTierChangeAtomic` (config-service-warmup-write.ts) just used,
  // which is atomic BY ITSELF via the `wp_warmup_apply_tier_change` SECURITY
  // DEFINER function (config-service.ts's own "ATOMICITY CONTRACT" doc) -
  // this module's established "sql may be a bare pool OR a transaction
  // handle, either way THIS ONE STATEMENT makes the transition atomic" shape,
  // never a new transaction opened here. transitionId = `result.configVersion`
  // - the real `pacing_events` row id is not returned by that definer
  // function (only `matched`/`new_config_version`), so this documents the
  // deliberate substitute: `configVersion` is strictly monotonic per
  // instance and non-wall-clock, the same "pick the stable id the write
  // already has" latitude the phase task grants for the logged_out site.
  await notify(deps.pool as unknown as TenantQueryable, {
    clientId: row.client_id,
    instanceId: row.instance_id,
    kind: 'warmup_tier_changed',
    transitionId: String(result.configVersion),
    payload: { instanceId: row.instance_id },
  });

  await deps.publish({
    type: 'instance.pacing_changed',
    clientId: row.client_id,
    instanceId: row.instance_id,
    band: row.health_band,
    tier: decision.toTier,
    effDailyCap: result.effective.eff_daily_cap,
    configVersion: result.configVersion,
  });
}
