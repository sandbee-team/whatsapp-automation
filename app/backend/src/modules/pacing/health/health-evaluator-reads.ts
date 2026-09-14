import type { TenantQueryable } from '@wp/db';
import type { PriorEvidence } from './score.js';
import type { BandChangeRecord, HealthBand } from './bands.js';

/**
 * health-evaluator-reads.ts (P16 Unit C, max-lines split of
 * `HealthEvaluator.ts` - same split idiom as `session-worker-discovery-
 * wiring.ts`, not a behavioural boundary) - the three read-only queries
 * `evaluate()` runs before making any decision: the current
 * `instance_pacing_state` row, the current `whatsapp_instances` row (health
 * state + account age), and the `pacing_events` BAND_CHANGE history
 * `bands.ts`'s anti-flap/hysteresis rules need.
 */

export interface PacingStateRow extends Record<string, unknown> {
  health_band: HealthBand;
  health_band_since: Date | null;
  last_band_improved_at: Date | null;
  last_evidence: PriorEvidence;
  last_hard_signal_at: Date | null;
  warmup_tier: number;
  eval_tier: number;
  // The `eff_*` limits in force at read time (CRITICAL 2 fix, P16 fix
  // round) - carried through to a hard-signal-pause write's own
  // `effectiveLimits` field so a pause row records the REAL resolved limits,
  // never an empty stub. `numeric` columns decode as strings via `pg` -
  // `hard-signal-pause.ts`'s own `effectiveLimits` type already accepts
  // `number | string | null` for exactly this reason.
  eff_daily_cap: number;
  eff_hourly_cap: number;
  eff_new_conv_cap: number;
  eff_gap_min_ms: number;
  eff_gap_max_ms: number;
  eff_cold_ratio_max: string;
  eff_cold_ratio_floor: number;
  eff_window_start_local: string;
  eff_window_end_local: string;
  eff_group_daily_cap: number;
  /** The instance's CURRENTLY STORED score (WARNING 9 fix, P16 fix round) - `numeric`, decodes as a string via `pg`; the fast lane forces a BAND, never a fabricated score, so it writes this value back unchanged. */
  health_score: string;
}

/** Builds the `effectiveLimits` payload `hard-signal-pause.ts` embeds from a `PacingStateRow` already read - the ONE place both the evaluator's CRITICAL branch and the fast-lane's connection-update pause derive this shape from, so they can never drift apart. */
export function effectiveLimitsFrom(
  row: PacingStateRow,
): Readonly<Record<string, number | string | null>> {
  return {
    eff_daily_cap: row.eff_daily_cap,
    eff_hourly_cap: row.eff_hourly_cap,
    eff_new_conv_cap: row.eff_new_conv_cap,
    eff_gap_min_ms: row.eff_gap_min_ms,
    eff_gap_max_ms: row.eff_gap_max_ms,
    eff_cold_ratio_max: row.eff_cold_ratio_max,
    eff_cold_ratio_floor: row.eff_cold_ratio_floor,
    eff_window_start_local: row.eff_window_start_local,
    eff_window_end_local: row.eff_window_end_local,
    eff_group_daily_cap: row.eff_group_daily_cap,
  };
}

export interface InstanceRow extends Record<string, unknown> {
  health_state: string;
  created_at: Date;
}

export async function readPacingStateRow(
  sql: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<PacingStateRow> {
  const result = await sql.query<PacingStateRow>(
    `SELECT health_band, health_band_since, last_band_improved_at, last_evidence,
            last_hard_signal_at, warmup_tier, eval_tier,
            eff_daily_cap, eff_hourly_cap, eff_new_conv_cap, eff_gap_min_ms, eff_gap_max_ms,
            eff_cold_ratio_max, eff_cold_ratio_floor, eff_window_start_local, eff_window_end_local,
            eff_group_daily_cap, health_score
       FROM instance_pacing_state
      WHERE instance_id = $1 AND client_id = $2`,
    [instanceId, clientId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`HealthEvaluator: no instance_pacing_state row for instance ${instanceId}`);
  }
  return row;
}

export async function readInstanceRow(
  sql: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<InstanceRow> {
  const result = await sql.query<InstanceRow>(
    `SELECT health_state, created_at FROM whatsapp_instances WHERE id = $1 AND client_id = $2`,
    [instanceId, clientId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`HealthEvaluator: no whatsapp_instances row for instance ${instanceId}`);
  }
  return row;
}

export async function readRecentBandChanges(
  sql: TenantQueryable,
  clientId: string,
  instanceId: string,
  sinceMs: number,
): Promise<BandChangeRecord[]> {
  const result = await sql.query<{
    created_at: Date;
    from_value: { band?: HealthBand } | null;
    to_value: { band?: HealthBand } | null;
  }>(
    `SELECT created_at, from_value, to_value FROM pacing_events
      WHERE client_id = $1 AND instance_id = $2 AND kind = 'BAND_CHANGE'
        AND created_at > $3
      ORDER BY created_at ASC`,
    [clientId, instanceId, new Date(sinceMs)],
  );
  return result.rows
    .filter((row) => row.from_value?.band !== undefined && row.to_value?.band !== undefined)
    .map((row) => ({
      atMs: row.created_at.getTime(),
      from: row.from_value?.band as HealthBand,
      to: row.to_value?.band as HealthBand,
    }));
}
