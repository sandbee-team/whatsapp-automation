import { describe, expect, it } from 'vitest';
import { backoff, BACKOFF_BASE_MS, BACKOFF_CAP_MS } from './backoff.js';
import type { Rng } from '../ports.js';

/** Deterministic seeded RNG: cycles through a fixed sequence in [0, 1). */
function seededRng(sequence: readonly number[]): Rng {
  let i = 0;
  return {
    random(): number {
      const v = sequence[i % sequence.length] as number;
      i += 1;
      return v;
    },
  };
}

describe('backoff', () => {
  it('backoff_is_capped_at_fifteen_minutes_and_fully_jittered', () => {
    // 10k draws spread across a fixed cycle of RNG values covering the
    // full [0, 1) range - every single draw must land inside [0, cap] for
    // its attempt, and the draws must not all be identical (a real full
    // jitter, not a fixed delay and not delay/2 + random(delay/2)).
    const rngValues = Array.from({ length: 97 }, (_, i) => i / 97);
    const rng = seededRng(rngValues);

    const seen = new Set<number>();
    for (let attempts = 0; attempts < 10; attempts += 1) {
      const cap = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempts);
      for (let draw = 0; draw < 1000; draw += 1) {
        const delay = backoff(attempts, rng);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(cap);
        seen.add(delay);
      }
    }

    // Not a fixed value: many distinct delays must have been produced.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('the_cap_is_exactly_min_900000_and_2000_times_2_pow_attempts', () => {
    const alwaysMax = seededRng([0.999999999]);

    expect(backoff(0, alwaysMax)).toBeLessThanOrEqual(2000);
    expect(backoff(0, alwaysMax)).toBeGreaterThan(1999);

    expect(backoff(1, alwaysMax)).toBeLessThanOrEqual(4000);
    expect(backoff(1, alwaysMax)).toBeGreaterThan(3999);

    // attempts large enough that 2s * 2^attempts would exceed 900_000 -
    // the cap must be exactly 900_000, never NaN/Infinity.
    expect(backoff(20, alwaysMax)).toBeLessThanOrEqual(900_000);
    expect(backoff(20, alwaysMax)).toBeGreaterThan(899_999);
  });

  it('a_huge_attempts_value_never_yields_nan_or_infinity', () => {
    const rng = seededRng([0.5]);

    const delay = backoff(10_000, rng);

    expect(Number.isFinite(delay)).toBe(true);
    expect(Number.isNaN(delay)).toBe(false);
    expect(delay).toBeLessThanOrEqual(900_000);
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  it('zero_draws_zero_delay_at_every_attempt', () => {
    const zeroRng = seededRng([0]);

    expect(backoff(0, zeroRng)).toBe(0);
    expect(backoff(5, zeroRng)).toBe(0);
  });
});
