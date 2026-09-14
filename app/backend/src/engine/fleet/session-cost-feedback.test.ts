import { describe, expect, it } from 'vitest';
import {
  computeSessionCostFeedback,
  type SessionCostFeedbackBudget,
  type WorkerRssSlopeSample,
} from './session-cost-feedback.js';

/**
 * session-cost-feedback.test.ts (P10 U6 step 9; CRITICAL 1/2 fixed
 * FIX-P10-A) - the PURE math behind the production feedback loop (ADR 0018
 * S3): a 24h trimmed mean of per-worker RSS-slope samples -> a candidate
 * `measuredSessionMb`, then guarded by a ±30%/day rate limit and a
 * floor-10/ceiling-250 clamp on the megabyte value, and a fail-safe no-op
 * when the sample window is missing/thin. `cap` is then DERIVED from the
 * accepted `measuredSessionMb` via `deriveSessionCapResult`'s real heap-
 * budget arithmetic (`./budget.js`) - every test below asserts the EXACT
 * `cap` value this arithmetic produces, not just a floor/ceiling bound
 * (CRITICAL 2: bounds-only assertions like `cap >= 10` would pass a MB value
 * masquerading as a session count, which is exactly the CRITICAL-1 bug this
 * fix corrects). All I/O (clock, metric emission, logging) is injected at
 * the scheduler boundary in `session-cost-feedback.ts` itself - this file
 * drives only the pure function.
 */

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/** The same heap-budget knobs `budget.test.ts`/`session-cost.md` use throughout this repo: (3072 - 200) / perSessionMb * 0.85, clamped to [10, 250]. */
const BUDGET: SessionCostFeedbackBudget = {
  heapBudgetMb: 3072,
  processBaselineMb: 200,
  plannedSessionMb: 35,
  safetyFactor: 0.85,
};

/** Builds `count` evenly-spaced samples across `windowMs` ending at `now`, each with the given `mb` value. */
function buildSamples(
  mb: readonly number[],
  now: number,
  windowMs: number = TWENTY_FOUR_HOURS_MS,
): WorkerRssSlopeSample[] {
  const step = windowMs / mb.length;
  return mb.map((sessionMb, i) => ({
    workerId: `w${String(i)}`,
    sessionMb,
    takenAt: now - windowMs + i * step,
  }));
}

describe('computeSessionCostFeedback', () => {
  it('trimmed_mean_ignores_the_top_and_bottom_decile', () => {
    const now = Date.now();
    // 10 workers at a steady 35 MB, plus one 400 MB outlier - the outlier
    // must land in the top decile and be dropped, so the fleet number stays
    // at 35, not skewed toward 400.
    const samples = buildSamples([35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 400], now);

    const result = computeSessionCostFeedback({
      samples,
      now,
      currentCapMb: 69,
      budget: BUDGET,
    });

    expect(result.changed).toBe(true);
    expect(result.clamped).toBe(false);
    expect(result.measuredSessionMb).toBe(35);
    expect(result.cap).toBe(69);
  });

  it('feedback_cannot_move_the_cap_more_than_thirty_percent_in_a_day', () => {
    const now = Date.now();
    // Every sample reports 105 MB - a 3x jump vs the current 35 MB
    // measurement. The candidate must be clamped to +30% (35 * 1.3 = 45.5),
    // logged as clamped, never applied raw.
    const samples = buildSamples(new Array(20).fill(105), now);

    const result = computeSessionCostFeedback({
      samples,
      now,
      currentMeasuredSessionMb: 35,
      currentCapMb: 69,
      budget: BUDGET,
    });

    expect(result.changed).toBe(true);
    expect(result.clamped).toBe(true);
    expect(result.reason).toBe('rate-limited');
    expect(result.measuredSessionMb).toBeCloseTo(35 * 1.3, 5);
    expect(result.cap).toBe(53);
  });

  it('a_missing_or_thin_metric_window_leaves_the_cap_unchanged', () => {
    const now = Date.now();

    // No samples at all.
    const emptyResult = computeSessionCostFeedback({
      samples: [],
      now,
      currentCapMb: 69,
      budget: BUDGET,
    });
    expect(emptyResult.changed).toBe(false);
    expect(emptyResult.reason).toBe('thin-window');
    expect(emptyResult.provisional).toBe(true);
    expect(emptyResult.hasMeasurement).toBe(false);
    expect(emptyResult.measuredSessionMb).toBeUndefined();
    expect(emptyResult.cap).toBe(69);

    // Samples exist but only span < 12h.
    const thinSamples = buildSamples([35, 35, 35, 35], now, TWELVE_HOURS_MS - 1000);
    const thinResult = computeSessionCostFeedback({
      samples: thinSamples,
      now,
      currentCapMb: 69,
      budget: BUDGET,
    });
    expect(thinResult.changed).toBe(false);
    expect(thinResult.reason).toBe('thin-window');
    expect(thinResult.provisional).toBe(true);
    expect(thinResult.hasMeasurement).toBe(false);
    expect(thinResult.measuredSessionMb).toBeUndefined();
    expect(thinResult.cap).toBe(69);
  });

  it('a_window_of_exactly_12h_is_the_boundary_and_must_be_accepted', () => {
    const now = Date.now();
    // Exactly TWELVE_HOURS_MS span (spanMs < MIN_WINDOW_MS is the reject
    // condition, so span === MIN_WINDOW_MS must PASS, not be treated as thin).
    const samples = buildSamples([35, 35, 35, 35], now, TWELVE_HOURS_MS);

    const result = computeSessionCostFeedback({ samples, now, currentCapMb: 69, budget: BUDGET });

    expect(result.changed).toBe(true);
    expect(result.reason).toBe('accepted');
    expect(result.provisional).toBe(false);
    expect(result.measuredSessionMb).toBe(35);
    expect(result.cap).toBe(69);
  });

  it('a_window_of_11h59m_one_ms_under_the_boundary_is_thin', () => {
    const now = Date.now();
    const samples = buildSamples([35, 35, 35, 35], now, TWELVE_HOURS_MS - 1);

    const result = computeSessionCostFeedback({ samples, now, currentCapMb: 69, budget: BUDGET });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe('thin-window');
  });

  it('a_single_sample_has_zero_span_and_is_always_thin_regardless_of_value', () => {
    const now = Date.now();
    const samples: WorkerRssSlopeSample[] = [{ workerId: 'w0', sessionMb: 35, takenAt: now }];

    const result = computeSessionCostFeedback({ samples, now, currentCapMb: 69, budget: BUDGET });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe('thin-window');
    expect(result.provisional).toBe(true);
  });

  it('all_identical_values_produce_a_stable_trimmed_mean_equal_to_that_value', () => {
    const now = Date.now();
    const samples = buildSamples(new Array(15).fill(42), now);

    const result = computeSessionCostFeedback({
      samples,
      now,
      currentMeasuredSessionMb: 42,
      currentCapMb: 69,
      budget: BUDGET,
    });

    expect(result.changed).toBe(true);
    expect(result.clamped).toBe(false);
    expect(result.measuredSessionMb).toBe(42);
    expect(result.cap).toBe(58);
  });

  it('a_ninety_percent_drop_is_clamped_to_the_thirty_percent_daily_floor_not_applied_raw', () => {
    const now = Date.now();
    // Every sample now reports 3.5 MB - a 90% drop vs the current 35 MB.
    // Must clamp to -30% (35 * 0.7 = 24.5), never apply the raw 3.5 figure.
    const samples = buildSamples(new Array(20).fill(3.5), now);

    const result = computeSessionCostFeedback({
      samples,
      now,
      currentMeasuredSessionMb: 35,
      currentCapMb: 69,
      budget: BUDGET,
    });

    expect(result.changed).toBe(true);
    expect(result.clamped).toBe(true);
    expect(result.reason).toBe('rate-limited');
    expect(result.measuredSessionMb).toBeCloseTo(35 * 0.7, 5);
    expect(result.cap).toBe(99);
  });

  it('clamp_bounds_movement_in_both_directions_up_and_down_are_each_capped_at_thirty_percent', () => {
    const now = Date.now();

    const upSamples = buildSamples(new Array(20).fill(1000), now);
    const upResult = computeSessionCostFeedback({
      samples: upSamples,
      now,
      currentMeasuredSessionMb: 50,
      currentCapMb: 69,
      budget: BUDGET,
    });
    expect(upResult.measuredSessionMb).toBeCloseTo(50 * 1.3, 5);
    expect(upResult.cap).toBe(37);

    const downSamples = buildSamples(new Array(20).fill(1), now);
    const downResult = computeSessionCostFeedback({
      samples: downSamples,
      now,
      currentMeasuredSessionMb: 50,
      currentCapMb: 69,
      budget: BUDGET,
    });
    expect(downResult.measuredSessionMb).toBeCloseTo(50 * 0.7, 5);
    expect(downResult.cap).toBe(69);
  });

  it('two_consecutive_days_can_each_move_thirty_percent_compounding_the_total_move', () => {
    const now = Date.now();
    const day1Samples = buildSamples(new Array(20).fill(1000), now);
    const day1 = computeSessionCostFeedback({
      samples: day1Samples,
      now,
      currentMeasuredSessionMb: 35,
      currentCapMb: 69,
      budget: BUDGET,
    });
    expect(day1.measuredSessionMb).toBeCloseTo(35 * 1.3, 5);
    expect(day1.cap).toBe(53);

    // Feed day 1's accepted result as day 2's "current" baseline, same
    // extreme high samples again - the SECOND day's move is a further +30%
    // relative to day1's already-moved value (35*1.3*1.3), not capped back to
    // the original baseline's +30%. This is documented, deliberate behavior
    // of the pure recompute (no cross-day memory beyond `currentMeasuredSessionMb`)
    // - pinned here so a future change to add multi-day memory is a conscious
    // decision, not an accidental regression.
    const day2Now = now + TWENTY_FOUR_HOURS_MS;
    const day2Samples = buildSamples(new Array(20).fill(1000), day2Now);
    const day2 = computeSessionCostFeedback({
      samples: day2Samples,
      now: day2Now,
      currentMeasuredSessionMb: day1.measuredSessionMb,
      currentCapMb: day1.cap,
      budget: BUDGET,
    });
    expect(day2.measuredSessionMb).toBeCloseTo(35 * 1.3 * 1.3, 5);
    expect(day2.cap).toBe(41);
  });

  it('clamps the resulting measured mb to the floor of 10 and ceiling of 250', () => {
    const now = Date.now();

    const tinySamples = buildSamples(new Array(20).fill(1), now);
    const flooredResult = computeSessionCostFeedback({
      samples: tinySamples,
      now,
      currentMeasuredSessionMb: 1,
      currentCapMb: 10,
      budget: BUDGET,
    });
    expect(flooredResult.measuredSessionMb).toBe(10);
    expect(flooredResult.cap).toBeGreaterThanOrEqual(10);
    expect(flooredResult.cap).toBe(244);

    const hugeSamples = buildSamples(new Array(20).fill(9000), now);
    const cappedResult = computeSessionCostFeedback({
      samples: hugeSamples,
      now,
      currentMeasuredSessionMb: 9000,
      currentCapMb: 250,
      budget: BUDGET,
    });
    expect(cappedResult.measuredSessionMb).toBe(250);
    expect(cappedResult.cap).toBeLessThanOrEqual(250);
    expect(cappedResult.cap).toBe(10);
  });
});
