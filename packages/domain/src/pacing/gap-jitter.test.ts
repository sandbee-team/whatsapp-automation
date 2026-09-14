import { describe, expect, it } from 'vitest';
import type { Rng } from '../ports.js';
import { applyLongPause, drawGapMs, type LongPauseState } from './gap-jitter.js';

/**
 * mulberry32 - a small, deterministic, seeded PRNG (public-domain
 * algorithm). Used only so this test's draws are exact and reproducible
 * across runs, never ambient (`Math.random` is banned in this package
 * anyway - see `wp/domain-no-wallclock`).
 */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    random(): number {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Log-uniform CDF on [min,max]: F(x) = (ln x - ln min) / (ln max - ln min). */
function logUniformCdf(x: number, min: number, max: number): number {
  return (Math.log(x) - Math.log(min)) / (Math.log(max) - Math.log(min));
}

/** Asymptotic Kolmogorov distribution p-value for statistic `d` over `n` samples (standard series form). */
function ksPValue(d: number, n: number): number {
  const t = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * d;
  let sum = 0;
  for (let k = 1; k <= 100; k += 1) {
    sum += (k % 2 === 0 ? -1 : 1) * Math.exp(-2 * k * k * t * t);
  }
  return Math.max(0, Math.min(1, 2 * sum));
}

describe('drawGapMs', () => {
  it('draw_gap_ms_is_log_uniform_and_bounded', () => {
    const rng = mulberry32(42);
    const min = 20_000;
    const max = 90_000;
    const n = 100_000;
    const draws: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const g = drawGapMs(min, max, rng);
      expect(g).toBeGreaterThanOrEqual(min);
      expect(g).toBeLessThanOrEqual(max);
      draws.push(g);
    }

    draws.sort((a, b) => a - b);
    let maxDiff = 0;
    for (let i = 0; i < n; i += 1) {
      const draw = draws[i];
      if (draw === undefined) throw new Error('unreachable: draws[i] within bounds');
      const empirical = (i + 1) / n;
      const theoretical = logUniformCdf(draw, min, max);
      maxDiff = Math.max(maxDiff, Math.abs(empirical - theoretical));
    }

    const p = ksPValue(maxDiff, n);
    // Seeded/deterministic: this exact D and p are reproducible for seed 42.
    expect(maxDiff).toBeLessThan(0.02);
    expect(p).toBeGreaterThan(0.01);
  });

  it('draw_gap_ms_at_rng_zero_returns_exactly_min', () => {
    const zeroRng: Rng = { random: () => 0 };
    expect(drawGapMs(20_000, 90_000, zeroRng)).toBe(20_000);
  });

  it('draw_gap_ms_never_below_absolute_floor_even_if_min_is_lower', () => {
    const zeroRng: Rng = { random: () => 0 };
    // ABSOLUTE_GAP_MIN_MS is 15_000; a caller passing a lower min is still floored at 15_000.
    expect(drawGapMs(1_000, 90_000, zeroRng)).toBe(15_000);
  });

  it('draw_gap_ms_rejects_invalid_bounds', () => {
    const rng = mulberry32(1);
    expect(() => drawGapMs(0, 100, rng)).toThrow(RangeError);
    expect(() => drawGapMs(100, 50, rng)).toThrow(RangeError);
  });

  it('draw_gap_ms_degenerate_min_equals_max_returns_exactly_that_value_never_nan_across_the_full_rng_range', () => {
    // minMs === maxMs collapses the log-uniform draw's own span (hi - lo)
    // to exactly 0 - `lo + rng.random() * 0` must never divide by zero or
    // produce NaN regardless of where in [0,1) the draw lands.
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const rng: Rng = { random: () => r };
      const result = drawGapMs(20_000, 20_000, rng);
      expect(Number.isNaN(result)).toBe(false);
      expect(result).toBe(20_000);
    }
  });
});

describe('applyLongPause', () => {
  it('long_pause_fires_within_eighteen_to_thirty_five_sends_and_caps_at_fifteen_minutes', () => {
    const rng = mulberry32(7);
    // Seed the first threshold deterministically the same way the module does.
    let state: LongPauseState = {
      sendsSinceLastPause: 0,
      nextPauseAtSends: 18 + Math.floor(rng.random() * 18),
    };
    expect(state.nextPauseAtSends).toBeGreaterThanOrEqual(18);
    expect(state.nextPauseAtSends).toBeLessThanOrEqual(35);

    const baseGapMs = 100_000; // 100s * up to 9x would be 900s = 15min exactly at the cap boundary
    let firedCount = 0;
    let sendsSinceFire = 0;
    for (let i = 0; i < 500; i += 1) {
      const result = applyLongPause(baseGapMs, state, rng);
      state = result.state;
      sendsSinceFire += 1;
      if (result.fired) {
        firedCount += 1;
        expect(sendsSinceFire).toBeGreaterThanOrEqual(18);
        expect(sendsSinceFire).toBeLessThanOrEqual(35);
        expect(result.gapMs).toBeGreaterThanOrEqual(baseGapMs);
        expect(result.gapMs).toBeLessThanOrEqual(15 * 60 * 1000);
        sendsSinceFire = 0;
      } else {
        expect(result.gapMs).toBe(baseGapMs);
      }
    }
    expect(firedCount).toBeGreaterThan(0);
  });

  it('long_pause_never_shortens_the_base_gap', () => {
    const rng = mulberry32(99);
    const state: LongPauseState = { sendsSinceLastPause: 17, nextPauseAtSends: 18 };
    const result = applyLongPause(50_000, state, rng);
    expect(result.fired).toBe(true);
    expect(result.gapMs).toBeGreaterThanOrEqual(50_000);
  });
});
