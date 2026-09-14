import { describe, expect, it } from 'vitest';
import { driftVerdict, type DriftSample } from './drift-verdict.js';
import { DegenerateResponseError } from './rss-regression.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_HOURS = 24;

/**
 * Small seeded linear-congruential generator (LCG) for deterministic
 * pseudo-noise - never Math.random() per @wp/domain's purity rule. Returns a
 * value in [0, 1); the caller scales/centers it.
 */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function buildSeries(
  days: number,
  hoursPerDay: number,
  baseMib: number,
  mibPerDay: number,
  noiseAmplitudeMib: number,
  seed: number,
): DriftSample[] {
  const rng = makeLcg(seed);
  const samples: DriftSample[] = [];
  const totalHours = days * hoursPerDay;
  for (let h = 0; h < totalHours; h += 1) {
    const dayFrac = h / DAY_HOURS;
    const noise = (rng() - 0.5) * 2 * noiseAmplitudeMib;
    const mib = baseMib + mibPerDay * dayFrac + noise;
    samples.push({ tsMs: h * HOUR_MS, rssBytes: mib * 1024 * 1024 });
  }
  return samples;
}

describe('drift verdict', () => {
  it('a_flat_seven_day_series_returns_no_drift', () => {
    const series = buildSeries(7, DAY_HOURS, 500, 0, 3, 42);

    const verdict = driftVerdict(series);

    expect(verdict.kind).toBe('no-drift');
    if (verdict.kind !== 'no-drift') throw new Error('expected no-drift');
    expect(verdict.slopeCi95.low).toBeLessThan(0);
    expect(verdict.slopeCi95.high).toBeGreaterThan(0);
    expect(verdict.spanDays).toBeCloseTo(7, 1);
    expect(verdict.sampleCount).toBe(168);
  });

  it('a_two_mb_per_day_upward_slope_is_flagged_as_drift', () => {
    const series = buildSeries(7, DAY_HOURS, 500, 2, 0.05, 7);

    const verdict = driftVerdict(series);

    expect(verdict.kind).toBe('drift');
    if (verdict.kind !== 'drift') throw new Error('expected drift');
    expect(verdict.slopeMbPerDay).toBeCloseTo(2, 1);
    expect(verdict.slopeCi95.low).toBeGreaterThan(0);
  });

  it('fewer_than_six_days_of_samples_returns_insufficient_data', () => {
    const series = buildSeries(3, DAY_HOURS, 500, 0, 3, 11);

    const verdict = driftVerdict(series);

    expect(verdict.kind).toBe('insufficient-data');
    if (verdict.kind !== 'insufficient-data') throw new Error('expected insufficient-data');
    expect(verdict.reason).toMatch(/span/i);
    expect('slopeMbPerDay' in verdict).toBe(false);
  });

  it('unsorted_input_gives_the_same_verdict_as_sorted', () => {
    const sorted = buildSeries(7, DAY_HOURS, 500, 2, 0.05, 99);
    const shuffled = [...sorted].reverse();

    const sortedVerdict = driftVerdict(sorted);
    const shuffledVerdict = driftVerdict(shuffled);

    expect(shuffledVerdict.kind).toBe(sortedVerdict.kind);
    if (sortedVerdict.kind === 'drift' && shuffledVerdict.kind === 'drift') {
      expect(shuffledVerdict.slopeMbPerDay).toBeCloseTo(sortedVerdict.slopeMbPerDay, 6);
    }
  });

  it('a_six_plus_day_series_with_only_fifty_percent_hourly_coverage_is_insufficient_data', () => {
    const full = buildSeries(7, DAY_HOURS, 500, 0, 3, 5);
    // Keep the first and last sample (preserves the >= 6-day span) but drop
    // every other sample in between, halving hourly coverage.
    const halfCoverage = full.filter((_, i) => i === 0 || i === full.length - 1 || i % 2 === 0);

    const verdict = driftVerdict(halfCoverage);

    expect(verdict.kind).toBe('insufficient-data');
    if (verdict.kind !== 'insufficient-data') throw new Error('expected insufficient-data');
    expect(verdict.reason).toMatch(/coverage/i);
  });

  it('a_strongly_negative_slope_is_no_drift', () => {
    const series = buildSeries(7, DAY_HOURS, 500, -50, 0.05, 3);

    const verdict = driftVerdict(series);

    expect(verdict.kind).toBe('no-drift');
  });

  it('an_all_identical_series_throws_degenerate_response_error', () => {
    const series = buildSeries(7, DAY_HOURS, 500, 0, 0, 1);

    expect(() => driftVerdict(series)).toThrow(DegenerateResponseError);
  });
});
