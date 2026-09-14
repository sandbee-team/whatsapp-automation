import { HEALTH_BAND_EFFECTS, WARMUP_LADDER, type HealthBand } from '@wp/domain';

/**
 * warmup-decision.ts (P13a warmup-ladder Unit U1, step 1) - the PURE decision
 * table `warmup-evaluator.ts`'s thin apply layer drives (same split as
 * `modules/queue/reaper.ts`'s `classifyReapedRow`): no I/O, no clock read of
 * its own (every timestamp arrives pre-resolved as an input), so the
 * integration suite can unit-drive this table directly.
 *
 * Rules (canon, verbatim from the dispatch spec):
 *   - `warmupStartedAtMs === null` -> HOLD (`missing_warmup_start`), fail-safe
 *     - never advance on missing data.
 *   - `isPaused` -> HOLD (`instance_paused`) - P16's territory, this
 *     evaluator never touches a paused instance's limits.
 *   - `band === 'critical'` -> HOLD (`critical_band_pause_owned_by_p16`) -
 *     CRITICAL does nothing here.
 *   - `HEALTH_BAND_EFFECTS[band].freezesWarmup` (watch, degraded, critical)
 *     freezes ADVANCE, but `degraded` (not `watch`) still allows exactly one
 *     ROLLBACK per episode (`degradedRollbackDueForEpisode`, computed by the
 *     caller from `pacing_events`/`warmup_tier_since` - this function does
 *     not read the database).
 *   - ADVANCE only when: `band === 'healthy'` AND `elapsedDays >=` the next
 *     tier's `dayFrom` AND NOT `hasRecentHardRestrictionSignal` (24h window,
 *     resolved by the caller).
 *   - At most one tier change per call - never more than one step either
 *     direction.
 */

export interface WarmupDecisionInput {
  warmupTier: number;
  /** ms epoch, or `null` if never started (fail-safe HOLD). */
  warmupStartedAtMs: number | null;
  healthBand: HealthBand;
  /** Any `pacing_events(kind='hard_signal_pause')` row for this instance within the last 24h - P16 is the future writer, this evaluator only reads. */
  hasRecentHardRestrictionSignal: boolean;
  /** `whatsapp_instances.health_state === 'paused'` - advancing limits on a paused instance is P16's territory. */
  isPaused: boolean;
  /** Whether a `degraded`-band rollback is still owed for the CURRENT degraded episode (computed by the caller from `pacing_events`/`warmup_tier_since` - never re-derived here). */
  degradedRollbackDueForEpisode: boolean;
  /** Elapsed calendar days since `warmupStartedAtMs`, in the instance's own `pacing_timezone`, start day = day 1 (computed by the caller - this module has no timezone/clock of its own). */
  elapsedDays: number;
}

export type WarmupDecision =
  | { action: 'hold'; reasonCodes: string[] }
  | { action: 'advance'; toTier: number; reasonCodes: string[]; evidence: Record<string, unknown> }
  | {
      action: 'rollback';
      toTier: number;
      reasonCodes: string[];
      evidence: Record<string, unknown>;
    };

const HOLD = (reasonCodes: string[]): WarmupDecision => ({ action: 'hold', reasonCodes });

/** Pure: decides the ONE tier action (or none) for one instance's current pacing state. */
export function decideWarmupAction(input: WarmupDecisionInput): WarmupDecision {
  if (input.warmupStartedAtMs === null) return HOLD(['missing_warmup_start']);
  if (input.isPaused) return HOLD(['instance_paused']);
  if (input.healthBand === 'critical') return HOLD(['critical_band_pause_owned_by_p16']);

  if (input.healthBand === 'degraded' && input.degradedRollbackDueForEpisode) {
    const toTier = Math.max(1, input.warmupTier - 1);
    if (toTier === input.warmupTier) return HOLD(['warmup_tier_floor_reached']);
    return {
      action: 'rollback',
      toTier,
      reasonCodes: ['health_band_degraded'],
      evidence: { fromTier: input.warmupTier, band: input.healthBand },
    };
  }

  if (HEALTH_BAND_EFFECTS[input.healthBand].freezesWarmup) {
    return HOLD([`warmup_frozen_${input.healthBand}`]);
  }

  const nextTier = WARMUP_LADDER.find((tier) => tier.tier === input.warmupTier + 1);
  if (!nextTier) return HOLD(['warmup_tier_ceiling_reached']);

  if (input.elapsedDays < nextTier.dayFrom) {
    return HOLD(['warmup_not_yet_due']);
  }
  if (input.hasRecentHardRestrictionSignal) {
    return HOLD(['hard_restriction_signal_recent']);
  }

  return {
    action: 'advance',
    toTier: nextTier.tier,
    reasonCodes: ['warmup_day_threshold_reached', 'no_restriction_signal_24h'],
    evidence: {
      fromTier: input.warmupTier,
      elapsedDays: input.elapsedDays,
      band: input.healthBand,
    },
  };
}
