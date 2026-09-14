import { describe, expect, it } from 'vitest';
import {
  fitRssRegression,
  TooFewRampPointsError,
  DegenerateRampPointsError,
  DegenerateResponseError,
} from './rss-regression.js';

describe('rss regression', () => {
  it('slope_is_fitted_not_total_over_sessions', () => {
    // baseline (socket-only) RSS 900 MB, then +20 MB per additional session:
    // rssMb = 900 + 20 * sessions. The naive "total mb / total sessions" an
    // engineer might reach for instead conflates the fixed 900 MB baseline
    // into the per-session figure - here it reads
    // (920+940+960+980+1000)/(1+2+3+4+5) = 4800/15 = 320, nowhere near the
    // true fitted slope of 20. The fit must recover ~20, not that.
    const points = [
      { sessions: 1, rssMb: 920 },
      { sessions: 2, rssMb: 940 },
      { sessions: 3, rssMb: 960 },
      { sessions: 4, rssMb: 980 },
      { sessions: 5, rssMb: 1000 },
    ];

    const fit = fitRssRegression(points);

    expect(fit.slopeMbPerSession).toBeCloseTo(20, 5);
    expect(fit.interceptMb).toBeCloseTo(900, 5);

    const naiveTotalOverSessions =
      points.reduce((sum, p) => sum + p.rssMb, 0) / points.reduce((sum, p) => sum + p.sessions, 0);
    expect(naiveTotalOverSessions).toBeCloseTo(320, 2);
    expect(fit.slopeMbPerSession).not.toBeCloseTo(naiveTotalOverSessions, 0);
  });

  it('fit_rejects_fewer_than_four_ramp_points', () => {
    const points = [
      { sessions: 1, rssMb: 920 },
      { sessions: 2, rssMb: 940 },
      { sessions: 3, rssMb: 960 },
    ];

    expect(() => fitRssRegression(points)).toThrow(TooFewRampPointsError);
    let threw: unknown;
    try {
      fitRssRegression(points);
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeInstanceOf(TooFewRampPointsError);
  });

  it('fit_rejects_identical_x_points_since_slope_is_undefined', () => {
    const points = [
      { sessions: 3, rssMb: 900 },
      { sessions: 3, rssMb: 905 },
      { sessions: 3, rssMb: 895 },
      { sessions: 3, rssMb: 910 },
    ];

    expect(() => fitRssRegression(points)).toThrow(/variance|identical|undefined/i);
  });

  it('fit_reports_r_squared_and_a_ninety_five_percent_interval', () => {
    const cleanPoints = [
      { sessions: 1, rssMb: 920 },
      { sessions: 2, rssMb: 940 },
      { sessions: 3, rssMb: 960 },
      { sessions: 4, rssMb: 980 },
      { sessions: 5, rssMb: 1000 },
    ];
    const cleanFit = fitRssRegression(cleanPoints);
    expect(cleanFit.rSquared).toBeGreaterThan(0.99);
    expect(cleanFit.slopeCi95.width).toBeGreaterThanOrEqual(0);

    const noisyPoints = [
      { sessions: 1, rssMb: 905 },
      { sessions: 2, rssMb: 955 },
      { sessions: 3, rssMb: 930 },
      { sessions: 4, rssMb: 1005 },
      { sessions: 5, rssMb: 970 },
      { sessions: 6, rssMb: 1060 },
    ];
    const noisyFit = fitRssRegression(noisyPoints);
    expect(noisyFit.rSquared).toBeLessThan(1);
    expect(noisyFit.slopeCi95.width).toBeGreaterThan(0);
    expect(noisyFit.slopeCi95.high).toBeGreaterThan(noisyFit.slopeCi95.low);
    expect(noisyFit.slopeCi95.low).toBeLessThanOrEqual(noisyFit.slopeMbPerSession);
    expect(noisyFit.slopeCi95.high).toBeGreaterThanOrEqual(noisyFit.slopeMbPerSession);
  });

  it('fit_accepts_exactly_four_points_the_minimum_boundary', () => {
    // Exactly MIN_RAMP_POINTS (4) must PASS, never throw.
    const points = [
      { sessions: 1, rssMb: 920 },
      { sessions: 2, rssMb: 940 },
      { sessions: 3, rssMb: 960 },
      { sessions: 4, rssMb: 980 },
    ];

    const fit = fitRssRegression(points);
    expect(fit.pointCount).toBe(4);
    expect(fit.slopeMbPerSession).toBeCloseTo(20, 5);
    expect(Number.isFinite(fit.slopeCi95.low)).toBe(true);
    expect(Number.isFinite(fit.slopeCi95.high)).toBe(true);
  });

  it('fit_rejects_exactly_three_points_one_below_the_boundary', () => {
    const points = [
      { sessions: 1, rssMb: 920 },
      { sessions: 2, rssMb: 940 },
      { sessions: 3, rssMb: 960 },
    ];
    expect(() => fitRssRegression(points)).toThrow(TooFewRampPointsError);
  });

  it('fit_rejects_duplicate_x_values_mixed_with_a_couple_distinct_ones_only_if_all_share_one_x', () => {
    // Not all-identical (some distinct sessions values) - must NOT throw
    // DegenerateRampPointsError, since x has real variance overall.
    const points = [
      { sessions: 3, rssMb: 900 },
      { sessions: 3, rssMb: 905 },
      { sessions: 5, rssMb: 950 },
      { sessions: 5, rssMb: 955 },
    ];
    expect(() => fitRssRegression(points)).not.toThrow();
  });

  it('fit_throws_degenerate_response_error_for_all_identical_y_values_never_reports_r_squared_one', () => {
    // SUGGESTION 14 (FIX-P10-A): flat rssMb across varying sessions (ssTot ===
    // 0) is exactly what a stuck/dead sampler produces, not a perfect fit.
    // Before this fix, the module silently reported rSquared: 1 (a zero-width
    // CI, slope 0) here - which a downstream `rSquared > 0.9` gate would
    // ACCEPT as an excellent measurement. This test previously asserted that
    // exact `rSquared === 1` behavior; it now pins the corrected throw
    // instead (the old assertion is deliberately replaced, not merely added
    // to - the pre-fix behavior is gone).
    const points = [
      { sessions: 1, rssMb: 900 },
      { sessions: 2, rssMb: 900 },
      { sessions: 3, rssMb: 900 },
      { sessions: 4, rssMb: 900 },
    ];

    expect(() => fitRssRegression(points)).toThrow(DegenerateResponseError);
    expect(() => fitRssRegression(points)).toThrow(/stuck\/dead sampler/);
  });

  it('fit_handles_negative_and_zero_rss_values_without_producing_nan_or_infinity', () => {
    // Degenerate/adversarial input (never expected in practice, but the pure
    // math must not blow up): negative and zero rssMb values.
    const points = [
      { sessions: 1, rssMb: -50 },
      { sessions: 2, rssMb: 0 },
      { sessions: 3, rssMb: 50 },
      { sessions: 4, rssMb: 100 },
    ];

    const fit = fitRssRegression(points);
    expect(Number.isFinite(fit.slopeMbPerSession)).toBe(true);
    expect(Number.isFinite(fit.interceptMb)).toBe(true);
    expect(Number.isFinite(fit.rSquared)).toBe(true);
    expect(fit.rSquared).toBeGreaterThanOrEqual(0);
    expect(fit.rSquared).toBeLessThanOrEqual(1);
  });

  it('fit_handles_a_single_wildly_outlying_point_without_nan_or_inverted_ci', () => {
    const points = [
      { sessions: 1, rssMb: 920 },
      { sessions: 2, rssMb: 940 },
      { sessions: 3, rssMb: 960 },
      { sessions: 4, rssMb: 980 },
      { sessions: 5, rssMb: 50000 }, // wild outlier
    ];

    const fit = fitRssRegression(points);
    expect(Number.isFinite(fit.slopeMbPerSession)).toBe(true);
    expect(fit.rSquared).toBeGreaterThanOrEqual(0);
    expect(fit.rSquared).toBeLessThanOrEqual(1);
    expect(fit.slopeCi95.low).toBeLessThanOrEqual(fit.slopeCi95.high);
    expect(Number.isNaN(fit.slopeCi95.low)).toBe(false);
    expect(Number.isNaN(fit.slopeCi95.high)).toBe(false);
  });

  it('fit_handles_very_large_session_counts_without_precision_blowup', () => {
    // Large N sessions and rssMb values - the OLS sums must not overflow or
    // lose so much precision that the slope drifts away from the true 20.
    const points = [
      { sessions: 1_000_000, rssMb: 900 + 20 * 1_000_000 },
      { sessions: 2_000_000, rssMb: 900 + 20 * 2_000_000 },
      { sessions: 3_000_000, rssMb: 900 + 20 * 3_000_000 },
      { sessions: 4_000_000, rssMb: 900 + 20 * 4_000_000 },
    ];

    const fit = fitRssRegression(points);
    expect(fit.slopeMbPerSession).toBeCloseTo(20, 3);
    expect(Number.isFinite(fit.interceptMb)).toBe(true);
  });

  it('fit_accepts_non_integer_session_counts', () => {
    // sessions is documented as a count but the pure math does not actually
    // require an integer - fractional inputs must not throw or NaN.
    const points = [
      { sessions: 1.5, rssMb: 930 },
      { sessions: 2.5, rssMb: 950 },
      { sessions: 3.5, rssMb: 970 },
      { sessions: 4.5, rssMb: 990 },
    ];

    const fit = fitRssRegression(points);
    expect(fit.slopeMbPerSession).toBeCloseTo(20, 5);
  });

  it('fit_gives_the_same_result_regardless_of_ramp_point_input_order', () => {
    // The OLS sums are order-independent, but pin this explicitly - a caller
    // handing in unsorted ramp points must get the identical fit as sorted.
    const sorted = [
      { sessions: 1, rssMb: 920 },
      { sessions: 2, rssMb: 940 },
      { sessions: 3, rssMb: 960 },
      { sessions: 4, rssMb: 980 },
    ];
    const shuffled = [sorted[2]!, sorted[0]!, sorted[3]!, sorted[1]!];

    const sortedFit = fitRssRegression(sorted);
    const shuffledFit = fitRssRegression(shuffled);

    expect(shuffledFit.slopeMbPerSession).toBeCloseTo(sortedFit.slopeMbPerSession, 10);
    expect(shuffledFit.interceptMb).toBeCloseTo(sortedFit.interceptMb, 10);
    expect(shuffledFit.rSquared).toBeCloseTo(sortedFit.rSquared, 10);
  });

  it('fit_throws_degenerate_error_for_five_points_sharing_one_x_value_beyond_four', () => {
    // All-identical x across MORE than the minimum 4 points - still must
    // throw DegenerateRampPointsError (not merely the 4-point case).
    const points = [
      { sessions: 7, rssMb: 900 },
      { sessions: 7, rssMb: 905 },
      { sessions: 7, rssMb: 895 },
      { sessions: 7, rssMb: 910 },
      { sessions: 7, rssMb: 890 },
    ];
    expect(() => fitRssRegression(points)).toThrow(DegenerateRampPointsError);
  });

  it('fit_accepts_large_point_counts_beyond_the_lookup_table_via_normal_approx', () => {
    // df = n - 2 = 34, beyond the 1..30 t-table -> must fall back to a
    // normal approximation rather than throwing or returning NaN.
    const points = Array.from({ length: 36 }, (_, i) => ({
      sessions: i + 1,
      rssMb: 900 + 20 * (i + 1),
    }));

    const fit = fitRssRegression(points);
    expect(Number.isFinite(fit.slopeCi95.low)).toBe(true);
    expect(Number.isFinite(fit.slopeCi95.high)).toBe(true);
    expect(fit.slopeMbPerSession).toBeCloseTo(20, 5);
  });
});
