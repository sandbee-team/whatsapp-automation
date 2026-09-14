import { describe, expect, it } from 'vitest';
import { createExpansionBudget } from './expansion-budget.js';

/**
 * expansion-budget.test.ts (P23 Unit U4) - the fleet-wide expansion token
 * bucket, unit-tested with an injected fake clock (never `Date.now()`,
 * never a sleep - `.claude/rules/core-invariants.md`'s ban on asserting
 * ambient timing). Exact expected values throughout, never a bound.
 */
describe('createExpansionBudget', () => {
  it('starts_with_burst_tokens_and_grants_ten_takes_of_500_then_denies_the_eleventh', () => {
    const nowMs = 0;
    const budget = createExpansionBudget({
      ratePerSecond: 5_000,
      burst: 5_000,
      clock: { now: () => nowMs },
    });

    for (let i = 0; i < 10; i += 1) {
      expect(budget.tryTake(500)).toBe(true);
    }
    expect(budget.tryTake(500)).toBe(false);
  });

  it('refills_exactly_500_tokens_after_100ms_at_5000_tokens_per_second', () => {
    let nowMs = 0;
    const budget = createExpansionBudget({
      ratePerSecond: 5_000,
      burst: 5_000,
      clock: { now: () => nowMs },
    });

    // Drain the bucket to exactly zero.
    for (let i = 0; i < 10; i += 1) {
      expect(budget.tryTake(500)).toBe(true);
    }
    expect(budget.tryTake(500)).toBe(false);

    // 100ms at 5000 tokens/sec refills exactly 500 tokens.
    nowMs += 100;
    expect(budget.tryTake(500)).toBe(true);
    expect(budget.tryTake(500)).toBe(false);
  });

  it('never_refills_past_the_burst_ceiling', () => {
    let nowMs = 0;
    const budget = createExpansionBudget({
      ratePerSecond: 5_000,
      burst: 5_000,
      clock: { now: () => nowMs },
    });

    // A long elapsed gap without any take must not accumulate beyond burst.
    nowMs += 10_000;
    for (let i = 0; i < 10; i += 1) {
      expect(budget.tryTake(500)).toBe(true);
    }
    expect(budget.tryTake(500)).toBe(false);
  });
});
