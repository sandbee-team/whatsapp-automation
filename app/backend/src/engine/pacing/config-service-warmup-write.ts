import { randomUUID } from 'node:crypto';
import type { HealthBand } from '@wp/domain';
import type { ConfigChangeKind, EffRow, PacingConfigQueryable } from './config-service.js';

/**
 * config-service-warmup-write.ts (P13a warmup-ladder Unit U1; FIX ROUND
 * CRITICAL 1/2) - split out of `config-service.ts` to stay under the
 * workspace's 300-line max-lines lint rule (the `session-cost-feedback-
 * timer.ts` split idiom: a sibling module owns one config-change kind's own
 * statement shape, `config-service.ts` calls into it). Owns the ONLY
 * statement a `kind: 'warmup_tier'` change runs beyond the shared `eff_*`
 * recompute every kind shares:
 *
 *   `applyWarmupTierChangeAtomic` - calls `wp_warmup_apply_tier_change`
 *   (migration 0034, SECURITY DEFINER, owned by the NOLOGIN/BYPASSRLS
 *   `wp_warmup` role), the ENTIRE guarded transition - tier-guarded
 *   `instance_pacing_state` UPDATE, `audit_logs` INSERT, `pacing_events`
 *   INSERT - in ONE atomic definer-function body, so two evaluator ticks
 *   racing on the SAME instance can never both apply a tier change (the
 *   loser's guard misses, a clean no-op, see `WarmupTierRaceLostError` in
 *   `config-service.ts`) AND a mid-sequence failure can never leave a tier
 *   change with no event (CRITICAL 2 - the old three-autocommitted-
 *   statements-on-a-bare-pool shape this replaces).
 *
 *   Before this fix round, this module ran the tier-guarded UPDATE and the
 *   `pacing_events` INSERT as two SEPARATE statements
 *   (`updateWarmupTierEffRow` + `insertWarmupTierEvent`, both since removed)
 *   directly against `instance_pacing_state`/`pacing_events` under whatever
 *   `sql` handle the caller passed in - `warmup-evaluator.ts` passes
 *   `deps.pool` (a raw, un-transacted connection), so those two statements
 *   were never atomic with each other despite `config-service.ts`'s own doc
 *   claiming "ONE transaction". Routing through the definer function fixes
 *   both problems at once: Postgres runs a SECURITY DEFINER function body as
 *   one implicit transaction, AND the function's `wp_warmup` owner holds
 *   exactly the grants the transition needs even though the caller
 *   (`wp_scheduler`) does not - see migration 0034's own header for the full
 *   rationale (`wp_scheduler` stays SELECT-only on `instance_pacing_state`,
 *   the P13 "narrow the writer" protection is fully preserved).
 */

export interface UpdateEffRowInput {
  sql: PacingConfigQueryable;
  instanceId: string;
  clientId: string;
  eff: EffRow;
  /**
   * FIX ROUND MAJOR 4 dependency fix: when the caller is a `kind:
   * 'health_band'` change, the resolved band ITSELF must also land on
   * `instance_pacing_state.health_band` - the column
   * `decideWarmupAction`/`isDegradedRollbackDue` (warmup-evaluator.ts) both
   * read. Before this fix, `updateEffRow` recomputed `eff_*` from the
   * degraded multiplier but never wrote `health_band`, so a real
   * `updatePacingConfig({kind:'health_band'})` call left the row still
   * reading its OLD band - only a direct fixture `UPDATE ... SET health_band
   * = ...` (test-only) ever actually changed it. Omit for every other kind
   * (`undefined`) to leave `health_band` untouched, exactly as before.
   */
  healthBand?: string;
}

/** The shared (non-warm-up-tier) `eff_*` UPDATE - unconditional on `instance_id`/`client_id` alone, exactly as every non-`warmup_tier` config-change kind has always run. Lives here (not `config-service.ts`) purely for the 300-line split - it is NOT warm-up-specific. */
export async function updateEffRow(input: UpdateEffRowInput): Promise<number | undefined> {
  const { eff } = input;
  const result = await input.sql.query<{ config_version: number }>(
    `UPDATE instance_pacing_state SET eff_daily_cap = $3, eff_hourly_cap = $4, eff_new_conv_cap = $5,
            eff_gap_min_ms = $6, eff_gap_max_ms = $7, eff_cold_ratio_max = $8,
            eff_cold_ratio_floor = $9, eff_window_start_local = COALESCE($10, eff_window_start_local),
            eff_window_end_local = COALESCE($11, eff_window_end_local),
            eff_group_daily_cap = $12, config_version = config_version + 1, updated_at = now(),
            health_band = COALESCE($13, health_band),
            health_band_since = CASE WHEN $13::text IS NOT NULL AND $13::text IS DISTINCT FROM health_band
                                     THEN now() ELSE health_band_since END
      WHERE instance_id = $1 AND client_id = $2
      RETURNING config_version`,
    [
      input.instanceId,
      input.clientId,
      eff.eff_daily_cap,
      eff.eff_hourly_cap,
      eff.eff_new_conv_cap,
      eff.eff_gap_min_ms,
      eff.eff_gap_max_ms,
      eff.eff_cold_ratio_max,
      eff.eff_cold_ratio_floor,
      eff.eff_window_start_local ?? null,
      eff.eff_window_end_local ?? null,
      eff.eff_group_daily_cap,
      input.healthBand ?? null,
    ],
  );
  return result.rows[0]?.config_version;
}

export interface ApplyWarmupTierChangeInput {
  sql: PacingConfigQueryable;
  instanceId: string;
  clientId: string;
  eff: EffRow;
  expectedFromWarmupTier: number;
  toWarmupTier: number;
  reason: string;
  reasonCodes: string[];
  evidence: Record<string, unknown>;
  actorUserId?: string | null;
}

/**
 * Calls `wp_warmup_apply_tier_change` (migration 0034) - the tier-guarded
 * UPDATE plus its `audit_logs`/`pacing_events` rows, all inside that
 * function's own atomic body. Returns `undefined` `config_version` when the
 * optimistic-concurrency guard matched zero rows (another tick won the
 * race) - the caller (`config-service.ts`) decides what that means
 * (`WarmupTierRaceLostError`). `sql` may be a bare pool/connection OR a
 * `tenantDb.withTenant`/transaction handle - either way this one statement
 * is what makes the whole transition atomic, not the caller's transaction
 * boundary (see module doc).
 */
export async function applyWarmupTierChangeAtomic(
  input: ApplyWarmupTierChangeInput,
): Promise<number | undefined> {
  const { eff } = input;
  const result = await input.sql.query<{ matched: boolean; new_config_version: number | null }>(
    `SELECT * FROM wp_warmup_apply_tier_change(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
     )`,
    [
      input.instanceId,
      input.clientId,
      input.expectedFromWarmupTier,
      input.toWarmupTier,
      eff.eff_daily_cap,
      eff.eff_hourly_cap,
      eff.eff_new_conv_cap,
      eff.eff_gap_min_ms,
      eff.eff_gap_max_ms,
      eff.eff_cold_ratio_max,
      eff.eff_cold_ratio_floor,
      eff.eff_window_start_local ?? null,
      eff.eff_window_end_local ?? null,
      eff.eff_group_daily_cap,
      input.reasonCodes,
      JSON.stringify(input.evidence),
      input.reason,
      input.actorUserId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row || row.matched !== true) return undefined;
  return row.new_config_version ?? undefined;
}

export interface InsertConfigAuditAndEventInput {
  sql: PacingConfigQueryable;
  clientId: string;
  instanceId: string;
  kind: Exclude<ConfigChangeKind, 'warmup_tier'>;
  reason: string;
  actorUserId?: string | null;
  eff: EffRow;
  /** `kind === 'health_band'` only - the band being LEFT, for the `BAND_CHANGE` event's `from_value` (see `config-service.ts`'s `UpdatePacingConfigInput.fromHealthBand`). */
  fromHealthBand?: HealthBand | null;
  /** `kind === 'health_band'` only - the resolved band being ENTERED. */
  toHealthBand?: HealthBand;
}

/**
 * The shared (non-warm-up-tier) `audit_logs` + `pacing_events` write pair -
 * every `ConfigChangeKind` except `warmup_tier` runs exactly this, split out
 * of `config-service.ts` purely for the 300-line cap (not warm-up-specific,
 * same as `updateEffRow` above). FIX ROUND MAJOR 4: a `health_band` change
 * writes the `BAND_CHANGE` `pacing_events` kind (from/to bands) instead of
 * the generic `CONFIG_CHANGE` every other kind still writes - this is the
 * anchor `isDegradedRollbackDue` (warmup-evaluator.ts) reads to find the
 * start of the CURRENT degraded episode.
 */
export async function insertConfigAuditAndEvent(
  input: InsertConfigAuditAndEventInput,
): Promise<void> {
  await input.sql.query(
    `INSERT INTO audit_logs (client_id, actor_type, actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, 'pacing.config.change', 'instance', $4, $5)
     -- client_id = $1`,
    [
      input.clientId,
      input.actorUserId ? 'user' : 'system',
      input.actorUserId ?? null,
      input.instanceId,
      JSON.stringify({ field: input.kind, reason: input.reason, to: input.eff }),
    ],
  );

  if (input.kind === 'health_band') {
    await input.sql.query(
      `INSERT INTO pacing_events (id, client_id, instance_id, kind, from_value, to_value, reason_codes, actor_user_id)
       VALUES ($1, $2, $3, 'BAND_CHANGE', $4, $5, $6, $7)
       -- client_id = $2
      `,
      [
        randomUUID(),
        input.clientId,
        input.instanceId,
        input.fromHealthBand ? JSON.stringify({ band: input.fromHealthBand }) : null,
        JSON.stringify({ band: input.toHealthBand }),
        [input.kind],
        input.actorUserId ?? null,
      ],
    );
    return;
  }

  await input.sql.query(
    `INSERT INTO pacing_events (id, client_id, instance_id, kind, to_value, reason_codes, actor_user_id)
     VALUES ($1, $2, $3, 'CONFIG_CHANGE', $4, $5, $6)
     -- client_id = $2
    `,
    [
      randomUUID(),
      input.clientId,
      input.instanceId,
      JSON.stringify(input.eff),
      [input.kind],
      input.actorUserId ?? null,
    ],
  );
}
