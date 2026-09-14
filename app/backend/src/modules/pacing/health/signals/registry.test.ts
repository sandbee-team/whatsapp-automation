import { describe, expect, it } from 'vitest';
import { HEALTH_SIGNALS, SCORED_SIGNAL_KEYS, WEIGHT_SUM, WEIGHTED_SIGNALS } from './registry.js';

/**
 * registry.test.ts (P16 Unit B, step 3) - the two mandatory named tests
 * proving the registry matches the canonical table exactly: weights sum to
 * 120, and the scored set is exactly the three v1 signals.
 */
describe('signals/registry', () => {
  it('signal_weights_sum_to_120', () => {
    expect(WEIGHT_SUM).toBe(120);
    // hard_restriction is an override (weight 0, no weight in the canon
    // table) and must be excluded from the weighted list entirely.
    expect(WEIGHTED_SIGNALS.some((signal) => signal.key === 'hard_restriction')).toBe(false);
    expect(WEIGHTED_SIGNALS).toHaveLength(11);
  });

  it('exactly_three_signals_are_scored_in_v1', () => {
    const scoredKeys = HEALTH_SIGNALS.filter((signal) => signal.scored).map((signal) => signal.key);
    expect(new Set(scoredKeys)).toEqual(
      new Set(['hard_restriction', 'rejected_send_rate', 'delivery_ratio']),
    );
    // Cross-check against the literal expected set exported by the
    // registry itself - adding a fourth scored signal anywhere turns this
    // red even if the ad-hoc set above were accidentally widened too.
    expect(scoredKeys.sort()).toEqual([...SCORED_SIGNAL_KEYS].sort((a, b) => a.localeCompare(b)));
    expect(SCORED_SIGNAL_KEYS.size).toBe(3);
  });
});
