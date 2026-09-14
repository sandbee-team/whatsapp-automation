import { describe, expect, it, vi } from 'vitest';
import { createAdmissionController } from './admission.js';
import type { WorkerSample } from './types.js';

/**
 * admission.test.ts (P09 Unit U2 step 3) - `AdmissionController` trend
 * logic. All thresholds are evaluated over a 3-sample trend, never a single
 * spike (canon). `budgetBytes` here is a nice round number so 80%/92% are
 * exact integers, keeping the fixtures easy to read.
 */

const BUDGET_BYTES = 1_000_000_000; // 1e9 bytes
const CAP = 100;

function makeSample(overrides: Partial<WorkerSample> = {}): WorkerSample {
  return {
    sessions: 10,
    rssBytes: 100_000_000, // 10% of budget
    heapOldSpaceBytes: 50_000_000,
    eventLoopLagP99Ms: 5,
    gcPauseP99Ms: 5,
    takenAt: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<Parameters<typeof createAdmissionController>[0]> = {}) {
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

describe('AdmissionController', () => {
  it('single_lag_spike_does_not_stop_grabbing', () => {
    const deps = makeDeps();
    const controller = createAdmissionController(deps);

    // Two healthy samples, then one lag spike - only 1 bad sample of 3.
    controller.onSample(makeSample({ eventLoopLagP99Ms: 5, takenAt: 0 }));
    controller.onSample(makeSample({ eventLoopLagP99Ms: 5, takenAt: 5000 }));
    controller.onSample(makeSample({ eventLoopLagP99Ms: 500, takenAt: 10000 }));

    const result = controller.canAcceptLease();
    expect(result.ok).toBe(true);
    expect(result.state).toBe('accepting');
  });

  it('holding_at_cap_or_eighty_percent_rss_or_lag', () => {
    // Trigger 1: sessions >= cap, sustained 3 samples.
    const capDeps = makeDeps();
    const capController = createAdmissionController(capDeps);
    for (let i = 0; i < 3; i++) {
      capController.onSample(makeSample({ sessions: CAP, takenAt: i * 5000 }));
    }
    expect(capController.canAcceptLease()).toMatchObject({ ok: false, state: 'holding' });

    // Trigger 2: rss > 80% of budget, sustained 3 samples.
    const rssDeps = makeDeps();
    const rssController = createAdmissionController(rssDeps);
    for (let i = 0; i < 3; i++) {
      rssController.onSample(makeSample({ rssBytes: 850_000_000, takenAt: i * 5000 }));
    }
    expect(rssController.canAcceptLease()).toMatchObject({ ok: false, state: 'holding' });

    // Trigger 3: lagP99 > 200ms, sustained 3 samples.
    const lagDeps = makeDeps();
    const lagController = createAdmissionController(lagDeps);
    for (let i = 0; i < 3; i++) {
      lagController.onSample(makeSample({ eventLoopLagP99Ms: 250, takenAt: i * 5000 }));
    }
    expect(lagController.canAcceptLease()).toMatchObject({ ok: false, state: 'holding' });
  });

  it('zero_headroom_degrades_in_place_instead_of_shedding', () => {
    const deps = makeDeps({ getFleetHeadroom: vi.fn(() => 0) });
    const controller = createAdmissionController(deps);

    for (let i = 0; i < 3; i++) {
      controller.onSample(makeSample({ rssBytes: 950_000_000, takenAt: i * 5000 }));
    }

    const result = controller.canAcceptLease();
    expect(result.ok).toBe(false);
    expect(result.state).not.toBe('shedding');
    expect(deps.victimChooser).not.toHaveBeenCalled();
    expect(deps.raiseCapacityAlert).toHaveBeenCalledTimes(1);
  });

  it('SUGGESTION FIX 9: degrade-in-place carries a distinct reason string from a plain cap/rss/lag hold, even though both share state "holding"', () => {
    const degradeDeps = makeDeps({ getFleetHeadroom: vi.fn(() => 0) });
    const degradeController = createAdmissionController(degradeDeps);
    for (let i = 0; i < 3; i++) {
      degradeController.onSample(makeSample({ rssBytes: 950_000_000, takenAt: i * 5000 }));
    }
    const degradeResult = degradeController.canAcceptLease();
    expect(degradeResult.state).toBe('holding');
    expect(degradeResult.reason).toBe(
      'sustained rss > 92% budget with zero fleet headroom - degrading in place',
    );

    const plainHoldDeps = makeDeps();
    const plainHoldController = createAdmissionController(plainHoldDeps);
    for (let i = 0; i < 3; i++) {
      plainHoldController.onSample(makeSample({ sessions: CAP, takenAt: i * 5000 }));
    }
    const plainHoldResult = plainHoldController.canAcceptLease();
    expect(plainHoldResult.state).toBe('holding');
    expect(plainHoldResult.reason).toBe('sustained cap/rss/lag threshold');
    expect(plainHoldResult.reason).not.toBe(degradeResult.reason);
  });

  it('shedding_when_rss_over_92_percent_and_headroom_positive', () => {
    const deps = makeDeps({ getFleetHeadroom: vi.fn(() => 10) });
    const controller = createAdmissionController(deps);

    for (let i = 0; i < 3; i++) {
      controller.onSample(makeSample({ rssBytes: 950_000_000, takenAt: i * 5000 }));
    }

    const result = controller.canAcceptLease();
    expect(result.ok).toBe(false);
    expect(result.state).toBe('shedding');
  });

  it('null_headroom_is_treated_as_zero_fail_safe', () => {
    const deps = makeDeps({ getFleetHeadroom: vi.fn(() => null) });
    const controller = createAdmissionController(deps);

    for (let i = 0; i < 3; i++) {
      controller.onSample(makeSample({ rssBytes: 950_000_000, takenAt: i * 5000 }));
    }

    const result = controller.canAcceptLease();
    expect(result.state).not.toBe('shedding');
    expect(deps.victimChooser).not.toHaveBeenCalled();
  });

  it('draining_never_accepts_a_lease', () => {
    const deps = makeDeps();
    const controller = createAdmissionController(deps);

    controller.onSample(makeSample({ takenAt: 0 }));
    controller.beginDrain();

    const result = controller.canAcceptLease();
    expect(result.ok).toBe(false);
    expect(result.state).toBe('draining');
  });

  it('shedding_three_times_in_an_hour_raises_thrashing', () => {
    const deps = makeDeps({ getFleetHeadroom: vi.fn(() => 10) });
    let clock = 0;
    deps.now = vi.fn(() => clock);
    const controller = createAdmissionController(deps);

    // Three separate shed episodes within an hour: sustain 3 samples of
    // high rss, then recover to below-shed (but still holding, to keep it
    // simple), then spike again - three times.
    for (let episode = 0; episode < 3; episode++) {
      for (let i = 0; i < 3; i++) {
        clock += 5000;
        controller.onSample(makeSample({ rssBytes: 950_000_000, takenAt: clock }));
      }
      // Recover to healthy so the next episode is a fresh sustained trend.
      for (let i = 0; i < 3; i++) {
        clock += 5000;
        controller.onSample(makeSample({ rssBytes: 100_000_000, takenAt: clock }));
      }
    }

    expect(deps.raiseThrashing).toHaveBeenCalledTimes(1);
  });
});
