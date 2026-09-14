import { describe, expect, it } from 'vitest';
import { decideWarmupAction, type WarmupDecisionInput } from './warmup-decision.js';

/**
 * warmup-decision.test.ts (P13a warmup-ladder, C2/E3 hardening pass) - pure
 * unit tests over `decideWarmupAction`'s decision table: precedence between
 * guards, exact day-boundary behaviour, and ladder floor/ceiling clamping.
 * No I/O, no clock, no `@wp/server-kit` import chain - matches the module's
 * own "no I/O" contract, so this file needs none of the integration
 * suite's fixtures or env stub.
 */

const BASE: WarmupDecisionInput = {
  warmupTier: 1,
  warmupStartedAtMs: 0,
  healthBand: 'healthy',
  hasRecentHardRestrictionSignal: false,
  isPaused: false,
  degradedRollbackDueForEpisode: false,
  elapsedDays: 1,
};

describe('decideWarmupAction', () => {
  it('holds_fail_safe_when_warmup_started_at_is_null_even_if_otherwise_due', () => {
    const decision = decideWarmupAction({
      ...BASE,
      warmupStartedAtMs: null,
      elapsedDays: 999, // would otherwise be far past every tier's dayFrom
    });
    expect(decision).toEqual({ action: 'hold', reasonCodes: ['missing_warmup_start'] });
  });

  it('advances_exactly_at_the_dayFrom_boundary_not_only_strictly_after', () => {
    // Tier 2's dayFrom is 3 - elapsedDays === 3 exactly must advance.
    const decision = decideWarmupAction({ ...BASE, warmupTier: 1, elapsedDays: 3 });
    expect(decision).toEqual({
      action: 'advance',
      toTier: 2,
      reasonCodes: ['warmup_day_threshold_reached', 'no_restriction_signal_24h'],
      evidence: { fromTier: 1, elapsedDays: 3, band: 'healthy' },
    });
  });

  it('holds_one_day_before_the_dayFrom_boundary_off_by_one', () => {
    const decision = decideWarmupAction({ ...BASE, warmupTier: 1, elapsedDays: 2 });
    expect(decision).toEqual({ action: 'hold', reasonCodes: ['warmup_not_yet_due'] });
  });

  it('holds_at_the_ceiling_tier_6_even_when_massively_overdue_never_tier_7', () => {
    const decision = decideWarmupAction({ ...BASE, warmupTier: 6, elapsedDays: 10_000 });
    expect(decision).toEqual({ action: 'hold', reasonCodes: ['warmup_tier_ceiling_reached'] });
  });

  it('never_skips_more_than_one_tier_even_when_elapsedDays_implies_tier_6', () => {
    // Tier 1 instance, 10000 elapsed days (would qualify for tier 6 by day
    // count alone) - decision table only ever steps ONE tier per call.
    const decision = decideWarmupAction({ ...BASE, warmupTier: 1, elapsedDays: 10_000 });
    expect(decision.action).toBe('advance');
    if (decision.action === 'advance') {
      expect(decision.toTier).toBe(2);
    }
  });

  it('holds_at_the_floor_tier_1_degraded_never_rolls_back_below_1', () => {
    const decision = decideWarmupAction({
      ...BASE,
      warmupTier: 1,
      healthBand: 'degraded',
      degradedRollbackDueForEpisode: true,
    });
    expect(decision).toEqual({ action: 'hold', reasonCodes: ['warmup_tier_floor_reached'] });
  });

  it('repeated_episodes_at_tier_1_stay_pinned_to_the_floor', () => {
    // Two consecutive degraded episodes at tier 1 - both must hold at the
    // floor, never oscillate or go negative.
    for (let i = 0; i < 2; i += 1) {
      const decision = decideWarmupAction({
        ...BASE,
        warmupTier: 1,
        healthBand: 'degraded',
        degradedRollbackDueForEpisode: true,
      });
      expect(decision).toEqual({ action: 'hold', reasonCodes: ['warmup_tier_floor_reached'] });
    }
  });

  it('isPaused_takes_precedence_over_a_due_degraded_rollback', () => {
    // Even though degraded + rollback-due would otherwise roll back, a
    // paused instance is P16's territory - this evaluator must not touch it.
    const decision = decideWarmupAction({
      ...BASE,
      warmupTier: 3,
      healthBand: 'degraded',
      degradedRollbackDueForEpisode: true,
      isPaused: true,
    });
    expect(decision).toEqual({ action: 'hold', reasonCodes: ['instance_paused'] });
  });

  it('isPaused_takes_precedence_over_a_due_advance', () => {
    const decision = decideWarmupAction({ ...BASE, elapsedDays: 3, isPaused: true });
    expect(decision).toEqual({ action: 'hold', reasonCodes: ['instance_paused'] });
  });

  it('critical_band_holds_even_when_a_degraded_style_rollback_would_otherwise_be_due', () => {
    // critical never rolls back here - P16 owns pausing on critical; this
    // evaluator's rollback path is degraded-only by construction.
    const decision = decideWarmupAction({
      ...BASE,
      warmupTier: 3,
      healthBand: 'critical',
      degradedRollbackDueForEpisode: true,
    });
    expect(decision).toEqual({
      action: 'hold',
      reasonCodes: ['critical_band_pause_owned_by_p16'],
    });
  });

  it('watch_band_never_rolls_back_even_if_a_rollback_flag_is_somehow_set', () => {
    // Rollback is gated on healthBand === 'degraded' specifically; watch
    // only freezes advancement, it must never consume a rollback flag.
    const decision = decideWarmupAction({
      ...BASE,
      warmupTier: 3,
      healthBand: 'watch',
      degradedRollbackDueForEpisode: true,
      elapsedDays: 999,
    });
    expect(decision).toEqual({ action: 'hold', reasonCodes: ['warmup_frozen_watch'] });
  });

  it('hard_restriction_signal_blocks_advance_but_never_blocks_a_due_rollback', () => {
    const decision = decideWarmupAction({
      ...BASE,
      warmupTier: 3,
      healthBand: 'degraded',
      degradedRollbackDueForEpisode: true,
      hasRecentHardRestrictionSignal: true,
    });
    expect(decision).toEqual({
      action: 'rollback',
      toTier: 2,
      reasonCodes: ['health_band_degraded'],
      evidence: { fromTier: 3, band: 'degraded' },
    });
  });

  it('hard_restriction_signal_blocks_an_otherwise_due_advance', () => {
    const decision = decideWarmupAction({
      ...BASE,
      elapsedDays: 3,
      hasRecentHardRestrictionSignal: true,
    });
    expect(decision).toEqual({ action: 'hold', reasonCodes: ['hard_restriction_signal_recent'] });
  });
});
