import type { TenantDb, TenantQueryable } from '@wp/db';
import type { HealthBand, PacingLayer } from '@wp/domain';
import { logger } from '@wp/server-kit';
import { WarmupTierRaceLostError, type PacingConfigQueryable } from './config-service.js';
import { evaluateOneInstance } from './warmup-evaluator-apply.js';
import type { DueInstanceRow } from './warmup-evaluator-row.js';

/**
 * warmup-evaluator.ts (P13a warmup-ladder Unit U1, step 1; FIX ROUND
 * CRITICAL 1/2/3) - the thin DB-driving apply layer around
 * `decideWarmupAction` (pure decision table, sibling module). Run ONLY from
 * the 5-minute per-instance pacing-evaluator cron loop
 * (`engine/cron/cron-wiring.ts`) - NEVER from the send path. Every applied
 * tier change goes through `updatePacingConfig({kind: 'warmup_tier'})`,
 * which itself now routes the tier-guarded UPDATE + audit_logs + pacing_
 * events writes through `wp_warmup_apply_tier_change` (migration 0034),
 * ONE atomic SECURITY DEFINER function body - this module never UPDATEs
 * `warmup_tier`/`eff_*` directly, and no longer needs its own transaction
 * boundary for that write.
 *
 * FIX ROUND CRITICAL 1: the cross-tenant due-instance SCAN and every
 * per-instance READ now go through the sanctioned mechanisms this schema
 * already uses for the reaper/reconciler - `wp_warmup_scan_due` (migration
 * 0034, SECURITY DEFINER, same "wp_scheduler is not BYPASSRLS and sees zero
 * rows on a bare cross-tenant SELECT against FORCE-RLS" fix already applied
 * to `wp_reap_expired_leases`/`wp_reconcile_scan_unresolved`) for the scan,
 * and `tenantDb.withTenant(clientId, ...)` (the `app.client_id` GUC, same
 * wiring `send-loop-worker-wiring.ts` uses for its own per-tenant reads) for
 * `hasRecentHardSignal`/`isDegradedRollbackDue`/`readSystemProfileLayer`.
 * `deps.pool` is still used for the scan call itself (a bare
 * `SELECT * FROM wp_warmup_scan_due($1)` needs no GUC - the definer
 * function's own BYPASSRLS owner supplies the cross-tenant reach) and for
 * nothing else.
 *
 * Bounded batch, not per-instance-forever (ADR 0018 S4): one bounded `LIMIT`
 * scan per tick, same class as the reaper/reconciler sweeps. `ORDER BY
 * random()` inside `wp_warmup_scan_due` (MAJOR 5) means a fleet larger than
 * `SWEEP_MAX_ROWS` gets a fair, unbiased sample every tick instead of the
 * same low-cardinality prefix of instances monopolising every pass.
 */

const SWEEP_MAX_ROWS = 500;

export interface WarmupMetrics {
  tierChange(result: 'advance' | 'rollback'): void;
}

const NOOP_METRICS: WarmupMetrics = { tierChange: () => undefined };

/** The narrow panel-notification port (canon: "a panel notification" = publishing `instance.pacing_changed` through the established realtime mechanism). IDs and small scalars only - see `@wp/domain`'s `REALTIME_PAYLOAD_KEYS['instance.pacing_changed']`. */
export type PacingEvaluatorPublish = (event: {
  type: 'instance.pacing_changed';
  clientId: string;
  instanceId: string;
  band: HealthBand;
  tier: number;
  effDailyCap: number;
  configVersion: number;
}) => Promise<void>;

export interface PacingEvaluatorPool extends PacingConfigQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface RunPacingEvaluatorSweepDeps {
  pool: PacingEvaluatorPool;
  /** FIX ROUND CRITICAL 1 - per-instance reads run under `tenantDb.withTenant(clientId, ...)` so `app.client_id` is set before any RLS-guarded SELECT. Same `TenantDb` port `engine/cron/cron-wiring.ts` already threads to the reaper/reconciler. */
  tenantDb: TenantDb;
  clock: { now(): number };
  publish: PacingEvaluatorPublish;
  env: string;
  metrics?: WarmupMetrics;
  /** Bounded batch size - defaults to `SWEEP_MAX_ROWS`, never unbounded. */
  limit?: number;
}

/** The outcome of one sweep - MAJOR 3: a per-instance failure is counted here, never allowed to abort the batch. */
export interface PacingEvaluatorSweepOutcome {
  scanned: number;
  errors: number;
}

/** The system-profile ceiling layer (`resolveEffective`'s `systemProfile` input) - read from `pacing_profiles` via the instance's own `profile_key`, same join `provision.ts` uses at instance-creation time. Runs under the caller's tenant-scoped `tx` (FIX ROUND CRITICAL 1). */
/** Exported (P16 Unit C) so `HealthEvaluator.ts` reuses this exact read instead of hand-rolling a second system-profile resolver - see that module's own doc comment. Behaviour unchanged. */
export async function readSystemProfileLayer(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<PacingLayer> {
  const result = await tx.query<{
    daily_cap_ceiling: number;
    hourly_cap_ceiling: number;
    gap_min_floor_ms: number;
    cold_ratio_max: string;
    cold_ratio_floor: number;
    window_start_local: string;
    window_end_local: string;
  }>(
    `SELECT p.daily_cap_ceiling, p.hourly_cap_ceiling, p.gap_min_floor_ms, p.cold_ratio_max,
            p.cold_ratio_floor, p.window_start_local, p.window_end_local
       FROM instance_pacing_state s
       JOIN pacing_profiles p ON p.key = s.profile_key
      WHERE s.instance_id = $1 AND s.client_id = $2`,
    [instanceId, clientId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `warmup-evaluator: no pacing_profiles row for instance ${instanceId} (missing profile_key join)`,
    );
  }
  return {
    dailyCap: row.daily_cap_ceiling,
    hourlyCap: row.hourly_cap_ceiling,
    gapMinMs: row.gap_min_floor_ms,
    coldRatioMax: Number(row.cold_ratio_max),
    coldRatioFloor: row.cold_ratio_floor,
    window: { startLocal: row.window_start_local, endLocal: row.window_end_local },
  };
}

/** Runs one pacing-evaluator sweep: scans due instances (bounded, via `wp_warmup_scan_due`), decides, and applies at most one tier change each via `updatePacingConfig`. Never called from the send path - the cron loop is the only production caller. MAJOR 3: one instance's failure is caught, logged and counted - it never aborts the rest of the batch. */
export async function runOnePacingEvaluatorSweep(
  deps: RunPacingEvaluatorSweepDeps,
): Promise<PacingEvaluatorSweepOutcome> {
  const metrics = deps.metrics ?? NOOP_METRICS;
  const limit = deps.limit ?? SWEEP_MAX_ROWS;
  const scan = await deps.pool.query<DueInstanceRow>(`SELECT * FROM wp_warmup_scan_due($1)`, [
    limit,
  ]);

  let errors = 0;
  for (const row of scan.rows) {
    try {
      await evaluateOneInstance(deps, row, metrics);
    } catch (err) {
      errors += 1;
      if (err instanceof WarmupTierRaceLostError) {
        // Expected under concurrency (another tick already applied a
        // change) - a quiet no-op, debug-level only, never counted as a
        // noisy failure.
        logger.debug(
          { instance_id: row.instance_id, client_id: row.client_id },
          'warmup evaluator: tier-change race lost, skipping this tick',
        );
        continue;
      }
      // Any OTHER per-instance error: log (ids only, never send-path
      // content) and continue - one corrupted/unexpected row must never
      // stop the rest of the fleet's warm-up progression for this tick
      // (MAJOR 3).
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { instance_id: row.instance_id, client_id: row.client_id },
        `warmup evaluator: instance evaluation failed, continuing sweep: ${message}`,
      );
    }
  }

  return { scanned: scan.rows.length, errors };
}
