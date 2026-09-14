import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createAdmissionController } from './admission.js';
import type { WorkerSample } from './types.js';
import {
  deriveSessionCap,
  assertHeapBudgetMatchesNodeFlags,
  HeapBudgetMismatchError,
} from './budget.js';

/**
 * fleet-unit-e3-edge-admission-budget.test.ts - P09 E3 edge-case pass,
 * unit-level only (no real PG/Redis), split out of
 * `fleet-unit-e3-edge.test.ts` at FIX-P09-B for the max-lines cap (topic
 * split only - same cases, unchanged). Targets AdmissionController/
 * deriveSessionCap/assertHeapBudgetMatchesNodeFlags boundary exactness and
 * trend semantics that the happy-path suites (admission.test.ts,
 * budget.test.ts) do not exercise. See
 * `fleet-unit-e3-edge-discovery.test.ts` for the discovery escalation/soft-
 * yield cases and `fleet-unit-e3-edge-drain.test.ts` for the drain/
 * markNeedsReconcile cases.
 */

const BUDGET_BYTES = 1_000_000_000; // 1e9 bytes, so 80%/92% land on exact integers.
const CAP = 100;

function makeSample(overrides: Partial<WorkerSample> = {}): WorkerSample {
  return {
    sessions: 10,
    rssBytes: 100_000_000,
    heapOldSpaceBytes: 50_000_000,
    eventLoopLagP99Ms: 5,
    gcPauseP99Ms: 5,
    takenAt: 0,
    ...overrides,
  };
}

function makeAdmissionDeps(
  overrides: Partial<Parameters<typeof createAdmissionController>[0]> = {},
) {
  return {
    getCap: vi.fn(() => CAP),
    budgetBytes: BUDGET_BYTES,
    getFleetHeadroom: vi.fn<() => number | null>(() => 10),
    victimChooser: vi.fn(() => []),
    raiseCapacityAlert: vi.fn(),
    raiseThrashing: vi.fn(),
    now: vi.fn(() => 0),
    ...overrides,
  };
}

describe('AdmissionController - boundary exactness', () => {
  it('rss_at_exactly_80_percent_does_not_trip_holding_but_80_percent_plus_one_byte_does', () => {
    const atBoundary = makeAdmissionDeps();
    const atController = createAdmissionController(atBoundary);
    for (let i = 0; i < 3; i++) {
      // Exactly 80% - the predicate is strict `>`, so this must NOT hold.
      atController.onSample(makeSample({ rssBytes: BUDGET_BYTES * 0.8, takenAt: i * 5000 }));
    }
    expect(atController.canAcceptLease()).toMatchObject({ ok: true, state: 'accepting' });

    const overBoundary = makeAdmissionDeps();
    const overController = createAdmissionController(overBoundary);
    for (let i = 0; i < 3; i++) {
      overController.onSample(makeSample({ rssBytes: BUDGET_BYTES * 0.8 + 1, takenAt: i * 5000 }));
    }
    expect(overController.canAcceptLease()).toMatchObject({ ok: false, state: 'holding' });
  });

  it('rss_at_exactly_92_percent_does_not_shed_but_92_percent_plus_one_byte_does', () => {
    const atBoundary = makeAdmissionDeps({ getFleetHeadroom: vi.fn(() => 10) });
    const atController = createAdmissionController(atBoundary);
    for (let i = 0; i < 3; i++) {
      // Exactly 92% of budget - also exactly 92% > 80%, so this DOES trip
      // holding (the >80% branch), but must NOT trip shedding (strict `>` at
      // the 92% shed threshold).
      atController.onSample(makeSample({ rssBytes: BUDGET_BYTES * 0.92, takenAt: i * 5000 }));
    }
    const atResult = atController.canAcceptLease();
    expect(atResult.state).not.toBe('shedding');
    expect(atResult).toMatchObject({ ok: false, state: 'holding' });

    const overBoundary = makeAdmissionDeps({ getFleetHeadroom: vi.fn(() => 10) });
    const overController = createAdmissionController(overBoundary);
    for (let i = 0; i < 3; i++) {
      overController.onSample(makeSample({ rssBytes: BUDGET_BYTES * 0.92 + 1, takenAt: i * 5000 }));
    }
    expect(overController.canAcceptLease()).toMatchObject({ ok: false, state: 'shedding' });
  });

  it('lag_at_exactly_200ms_does_not_trip_holding_but_200ms_plus_epsilon_does', () => {
    const atBoundary = makeAdmissionDeps();
    const atController = createAdmissionController(atBoundary);
    for (let i = 0; i < 3; i++) {
      atController.onSample(makeSample({ eventLoopLagP99Ms: 200, takenAt: i * 5000 }));
    }
    expect(atController.canAcceptLease()).toMatchObject({ ok: true, state: 'accepting' });

    const overBoundary = makeAdmissionDeps();
    const overController = createAdmissionController(overBoundary);
    for (let i = 0; i < 3; i++) {
      overController.onSample(makeSample({ eventLoopLagP99Ms: 200.001, takenAt: i * 5000 }));
    }
    expect(overController.canAcceptLease()).toMatchObject({ ok: false, state: 'holding' });
  });

  it('sessions_at_exactly_cap_trips_holding_but_cap_minus_one_does_not', () => {
    const atCap = makeAdmissionDeps();
    const atController = createAdmissionController(atCap);
    for (let i = 0; i < 3; i++) {
      atController.onSample(makeSample({ sessions: CAP, takenAt: i * 5000 }));
    }
    expect(atController.canAcceptLease()).toMatchObject({ ok: false, state: 'holding' });

    const underCap = makeAdmissionDeps();
    const underController = createAdmissionController(underCap);
    for (let i = 0; i < 3; i++) {
      underController.onSample(makeSample({ sessions: CAP - 1, takenAt: i * 5000 }));
    }
    expect(underController.canAcceptLease()).toMatchObject({ ok: true, state: 'accepting' });
  });
});

describe('AdmissionController - trend semantics', () => {
  it('bad_good_bad_alternating_never_trips_holding_because_no_3_sample_window_is_all_bad', () => {
    const deps = makeAdmissionDeps();
    const controller = createAdmissionController(deps);

    // bad, good, bad, good, bad - every consecutive-3 window contains at
    // least one healthy sample, so holding must never trip.
    const badSample = makeSample({ eventLoopLagP99Ms: 500 });
    const goodSample = makeSample({ eventLoopLagP99Ms: 5 });
    const sequence = [badSample, goodSample, badSample, goodSample, badSample];

    for (let i = 0; i < sequence.length; i++) {
      controller.onSample({ ...sequence[i]!, takenAt: i * 5000 });
      const result = controller.canAcceptLease();
      expect(result.state).not.toBe('holding');
    }
  });

  it('recovery_three_good_samples_after_holding_returns_to_accepting', () => {
    const deps = makeAdmissionDeps();
    const controller = createAdmissionController(deps);

    for (let i = 0; i < 3; i++) {
      controller.onSample(makeSample({ eventLoopLagP99Ms: 500, takenAt: i * 5000 }));
    }
    expect(controller.canAcceptLease()).toMatchObject({ ok: false, state: 'holding' });

    for (let i = 3; i < 6; i++) {
      controller.onSample(makeSample({ eventLoopLagP99Ms: 5, takenAt: i * 5000 }));
    }
    expect(controller.canAcceptLease()).toMatchObject({ ok: true, state: 'accepting' });
  });

  it('fewer_than_3_samples_ever_taken_fails_safe_to_accepting_not_a_crash', () => {
    const deps = makeAdmissionDeps();
    const controller = createAdmissionController(deps);

    // Zero samples.
    expect(controller.canAcceptLease()).toMatchObject({ ok: true, state: 'accepting' });

    // One bad sample only - trend window incomplete, must not hold on a
    // single spike even at an extreme value.
    controller.onSample(
      makeSample({ rssBytes: BUDGET_BYTES * 10, eventLoopLagP99Ms: 99999, takenAt: 0 }),
    );
    expect(controller.canAcceptLease()).toMatchObject({ ok: true, state: 'accepting' });

    // Two bad samples - still incomplete.
    controller.onSample(
      makeSample({ rssBytes: BUDGET_BYTES * 10, eventLoopLagP99Ms: 99999, takenAt: 5000 }),
    );
    expect(controller.canAcceptLease()).toMatchObject({ ok: true, state: 'accepting' });
  });
});

describe('deriveSessionCap - boundary exactness', () => {
  it('perSession_value_landing_exactly_on_the_floor_boundary', () => {
    // usable = 3072 - 200 = 2872; want raw*safetyFactor == 10 exactly.
    // perSession chosen so (2872/perSession)*0.85 == 10 -> perSession = 2872*0.85/10 = 244.12
    const perSession = (2872 * 0.85) / 10;
    const cap = deriveSessionCap({
      heapBudgetMb: 3072,
      processBaselineMb: 200,
      plannedSessionMb: perSession,
      measuredSessionMb: undefined,
      safetyFactor: 0.85,
    });
    expect(cap).toBe(10);

    // One step below (larger perSession -> smaller raw) must clamp to the
    // same floor, never below it.
    const cappedBelow = deriveSessionCap({
      heapBudgetMb: 3072,
      processBaselineMb: 200,
      plannedSessionMb: perSession * 2,
      measuredSessionMb: undefined,
      safetyFactor: 0.85,
    });
    expect(cappedBelow).toBe(10);
  });

  it('perSession_value_landing_exactly_on_the_ceiling_boundary', () => {
    // usable = 2872; want raw*safetyFactor == 250 exactly.
    const perSession = (2872 * 0.85) / 250;
    const cap = deriveSessionCap({
      heapBudgetMb: 3072,
      processBaselineMb: 200,
      plannedSessionMb: perSession,
      measuredSessionMb: undefined,
      safetyFactor: 0.85,
    });
    expect(cap).toBe(250);

    // Smaller perSession (larger raw) must clamp to the same ceiling.
    const cappedAbove = deriveSessionCap({
      heapBudgetMb: 3072,
      processBaselineMb: 200,
      plannedSessionMb: perSession / 2,
      measuredSessionMb: undefined,
      safetyFactor: 0.85,
    });
    expect(cappedAbove).toBe(250);
  });
});

describe('assertHeapBudgetMatchesNodeFlags - conflicting sources', () => {
  it('execArgv_and_NODE_OPTIONS_both_set_but_disagreeing_with_each_other_uses_execArgv_and_still_validates_against_config', () => {
    const cfg = { heapBudgetMb: 3072 } as const;

    // execArgv says 3072 (matches config); NODE_OPTIONS disagrees with
    // execArgv (says 2048) but execArgv wins per the documented precedence -
    // this must NOT throw, since the winning source (execArgv) matches cfg.
    expect(() =>
      assertHeapBudgetMatchesNodeFlags(
        cfg,
        ['--max-old-space-size=3072'],
        '--max-old-space-size=2048',
      ),
    ).not.toThrow();

    // execArgv says 2048 (disagrees with config); NODE_OPTIONS says 3072
    // (would match config) - execArgv still wins per precedence, so this
    // MUST throw (fail-safe: never silently prefer the env-based source once
    // execArgv carries any flag at all).
    expect(() =>
      assertHeapBudgetMatchesNodeFlags(
        cfg,
        ['--max-old-space-size=2048'],
        '--max-old-space-size=3072',
      ),
    ).toThrow(HeapBudgetMismatchError);
  });
});
