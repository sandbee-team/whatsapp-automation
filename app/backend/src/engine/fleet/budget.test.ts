import { describe, expect, it } from 'vitest';
import {
  assertHeapBudgetMatchesNodeFlags,
  deriveSessionCap,
  deriveSessionCapResult,
  HeapBudgetMismatchError,
} from './budget.js';

/**
 * budget.test.ts (P09 Unit U1) - `deriveSessionCap` derives a worker's
 * session capacity from the heap budget config; `assertHeapBudgetMatchesNodeFlags`
 * is the boot assertion that the process was actually launched with
 * `--max-old-space-size` matching `WORKER_HEAP_BUDGET_MB` (checked via
 * injected `execArgv`/`NODE_OPTIONS` inputs, no real flags needed).
 *
 * The 135/69 figures below are DERIVED bracket numbers (pessimistic 35MB /
 * optimistic 18MB per-session estimates) - they may appear in code/tests/
 * comments labelled derived, never in panel strings or customer-facing text
 * (ADR 0018 S8).
 */
describe('deriveSessionCap', () => {
  it('cap_is_135_at_18mb_and_69_at_35mb', () => {
    // (3072 - 200) / 18 * 0.85 = 2872 / 18 * 0.85 = 159.555... * 0.85 = 135.62 -> floor 135
    const optimistic = deriveSessionCap({
      heapBudgetMb: 3072,
      processBaselineMb: 200,
      plannedSessionMb: 18,
      measuredSessionMb: undefined,
      safetyFactor: 0.85,
    });
    expect(optimistic).toBe(135);

    // (3072 - 200) / 35 * 0.85 = 2872 / 35 * 0.85 = 82.057... * 0.85 = 69.75 -> floor 69
    const pessimistic = deriveSessionCap({
      heapBudgetMb: 3072,
      processBaselineMb: 200,
      plannedSessionMb: 35,
      measuredSessionMb: undefined,
      safetyFactor: 0.85,
    });
    expect(pessimistic).toBe(69);
  });

  it('cap_floor_is_ten_and_ceiling_is_250', () => {
    // Absurdly large per-session footprint drives the raw cap below the floor.
    const flooredAtTen = deriveSessionCap({
      heapBudgetMb: 3072,
      processBaselineMb: 200,
      plannedSessionMb: 10000,
      measuredSessionMb: undefined,
      safetyFactor: 0.85,
    });
    expect(flooredAtTen).toBe(10);

    // Absurdly small per-session footprint drives the raw cap far above 250.
    const cappedAt250 = deriveSessionCap({
      heapBudgetMb: 3072,
      processBaselineMb: 200,
      plannedSessionMb: 1,
      measuredSessionMb: undefined,
      safetyFactor: 0.85,
    });
    expect(cappedAt250).toBe(250);
  });

  it('measured_session_mb_wins_over_planned', () => {
    // measuredSessionMb=35 should behave exactly like the pessimistic case
    // above, even though plannedSessionMb is set to a wildly different value
    // that would produce a different cap if it were used instead.
    const cap = deriveSessionCap({
      heapBudgetMb: 3072,
      processBaselineMb: 200,
      plannedSessionMb: 5,
      measuredSessionMb: 35,
      safetyFactor: 0.85,
    });
    expect(cap).toBe(69);
  });
});

describe('deriveSessionCapResult', () => {
  it('measured_session_mb_is_used_and_planned_is_only_a_fallback', () => {
    // measuredSessionMb present: it is used verbatim, and plannedSessionMb
    // (set to a wildly different value here) is never even read - the cap
    // is NOT provisional.
    const measured = deriveSessionCapResult({
      heapBudgetMb: 3072,
      processBaselineMb: 200,
      plannedSessionMb: 5,
      measuredSessionMb: 35,
      safetyFactor: 0.85,
    });
    expect(measured).toEqual({ cap: 69, provisional: false });

    // measuredSessionMb absent: plannedSessionMb is used as the fallback,
    // and the result is tagged provisional so callers can surface that this
    // cap rests on a derived bracket, not a real measurement.
    const planned = deriveSessionCapResult({
      heapBudgetMb: 3072,
      processBaselineMb: 200,
      plannedSessionMb: 35,
      measuredSessionMb: undefined,
      safetyFactor: 0.85,
    });
    expect(planned).toEqual({ cap: 69, provisional: true });
  });

  it('cap_recomputed_from_measurement_respects_floor_ten_and_ceiling_250', () => {
    // Absurdly large measured per-session footprint drives the raw cap
    // below the floor.
    const flooredAtTen = deriveSessionCapResult({
      heapBudgetMb: 3072,
      processBaselineMb: 200,
      plannedSessionMb: 35,
      measuredSessionMb: 10000,
      safetyFactor: 0.85,
    });
    expect(flooredAtTen).toEqual({ cap: 10, provisional: false });

    // Absurdly small measured per-session footprint drives the raw cap far
    // above 250.
    const cappedAt250 = deriveSessionCapResult({
      heapBudgetMb: 3072,
      processBaselineMb: 200,
      plannedSessionMb: 35,
      measuredSessionMb: 1,
      safetyFactor: 0.85,
    });
    expect(cappedAt250).toEqual({ cap: 250, provisional: false });
  });
});

describe('deriveSessionCap edge cases', () => {
  it('measured_session_mb_of_zero_is_not_treated_as_absent_and_is_used_verbatim', () => {
    // `measuredSessionMb ?? plannedSessionMb` only falls back on
    // undefined/null - 0 is a legal (if degenerate) measured value and must
    // still be used, not silently replaced by planned. Division by 0 yields
    // Infinity, floored/clamped to the 250 ceiling, never NaN or a crash.
    const cap = deriveSessionCap({
      heapBudgetMb: 3072,
      processBaselineMb: 200,
      plannedSessionMb: 35,
      measuredSessionMb: 0,
      safetyFactor: 0.85,
    });
    expect(cap).toBe(250);
    expect(Number.isNaN(cap)).toBe(false);
  });

  it('negative_usable_heap_from_a_baseline_exceeding_the_budget_still_floors_at_ten', () => {
    // processBaselineMb > heapBudgetMb makes `usable` negative - the raw
    // computation goes negative, and the floor/ceiling clamp must still
    // produce a valid, in-range cap (never a negative session cap).
    const cap = deriveSessionCap({
      heapBudgetMb: 100,
      processBaselineMb: 200,
      plannedSessionMb: 35,
      measuredSessionMb: undefined,
      safetyFactor: 0.85,
    });
    expect(cap).toBe(10);
  });

  it('a_provisional_result_can_still_be_floor_or_ceiling_clamped', () => {
    const result = deriveSessionCapResult({
      heapBudgetMb: 100,
      processBaselineMb: 200,
      plannedSessionMb: 35,
      measuredSessionMb: undefined,
      safetyFactor: 0.85,
    });
    expect(result).toEqual({ cap: 10, provisional: true });
  });
});

describe('assertHeapBudgetMatchesNodeFlags', () => {
  const cfg = { heapBudgetMb: 3072 } as const;

  it('boot_fails_when_max_old_space_size_disagrees_with_heap_budget', () => {
    expect(() =>
      assertHeapBudgetMatchesNodeFlags(cfg, ['--max-old-space-size=2048'], undefined),
    ).toThrow(HeapBudgetMismatchError);
  });

  it('passes_when_execArgv_matches', () => {
    expect(() =>
      assertHeapBudgetMatchesNodeFlags(cfg, ['--max-old-space-size=3072'], undefined),
    ).not.toThrow();
  });

  it('passes_when_NODE_OPTIONS_matches_and_execArgv_has_no_flag', () => {
    expect(() =>
      assertHeapBudgetMatchesNodeFlags(cfg, [], '--max-old-space-size=3072'),
    ).not.toThrow();
  });

  it('fails_when_neither_execArgv_nor_NODE_OPTIONS_set_the_flag', () => {
    expect(() => assertHeapBudgetMatchesNodeFlags(cfg, [], undefined)).toThrow(
      HeapBudgetMismatchError,
    );
  });

  it('execArgv_takes_precedence_over_a_disagreeing_NODE_OPTIONS_value', () => {
    // Both sources set the flag, with DIFFERENT values - execArgv (the
    // directly-passed flag) must win, matching the "checks execArgv first"
    // doc comment.
    expect(() =>
      assertHeapBudgetMatchesNodeFlags(
        cfg,
        ['--max-old-space-size=3072'],
        '--max-old-space-size=1024',
      ),
    ).not.toThrow();
  });
});
