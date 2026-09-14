import { describe, expect, it } from 'vitest';
import {
  computeSessionCostFeedback,
  type SessionCostFeedbackBudget,
  type WorkerRssSlopeSample,
} from './session-cost-feedback.js';

/**
 * session-cost-feedback-cap-derivation.test.ts (FIX-P10-A CRITICAL 1) -
 * split out from `session-cost-feedback.test.ts` (which stays under the
 * repo's max-lines cap) to pin the two CRITICAL-1 unit-confusion bugs:
 *   1. `cap` used to be a bare floor/ceiling clamp of the megabyte value
 *      itself, instead of the session count `deriveSessionCapResult`'s real
 *      heap-budget arithmetic derives from it.
 *   2. the thin-window no-op path used to fall back to `currentCapMb` (a
 *      session COUNT) as the reported `measuredSessionMb` (a MEGABYTE value)
 *      whenever a prior measurement existed.
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

describe('computeSessionCostFeedback cap derivation (CRITICAL 1)', () => {
  it('cap_is_derived_from_the_heap_budget_not_the_megabyte_value', () => {
    // 35 MB/session with this budget must yield cap 69 (never 35 - the
    // pre-fix bug); 18 MB/session must yield 135 (never 18).
    const now = Date.now();

    const at35 = computeSessionCostFeedback({
      samples: buildSamples(new Array(20).fill(35), now),
      now,
      currentMeasuredSessionMb: 35,
      currentCapMb: 69,
      budget: BUDGET,
    });
    expect(at35.measuredSessionMb).toBe(35);
    expect(at35.cap).toBe(69);
    expect(at35.cap).not.toBe(35);

    const at18 = computeSessionCostFeedback({
      samples: buildSamples(new Array(20).fill(18), now),
      now,
      currentMeasuredSessionMb: 18,
      currentCapMb: 135,
      budget: BUDGET,
    });
    expect(at18.measuredSessionMb).toBe(18);
    expect(at18.cap).toBe(135);
    expect(at18.cap).not.toBe(18);
  });

  it('a_thin_window_with_a_prior_measurement_derives_cap_from_that_prior_measurement_not_a_stand_in', () => {
    // `measuredSessionMb` stays the real PRIOR measurement (18 MB), and
    // `cap` is re-derived from that real MB figure via the heap budget
    // (135), never the raw `currentCapMb` count substituted as an MB value.
    const now = Date.now();
    const thinSamples = buildSamples([18, 18, 18, 18], now, TWELVE_HOURS_MS - 1000);

    const result = computeSessionCostFeedback({
      samples: thinSamples,
      now,
      currentMeasuredSessionMb: 18,
      currentCapMb: 135,
      budget: BUDGET,
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe('thin-window');
    expect(result.hasMeasurement).toBe(true);
    expect(result.measuredSessionMb).toBe(18);
    expect(result.measuredSessionMb).not.toBe(135);
    expect(result.cap).toBe(135);
  });
});
