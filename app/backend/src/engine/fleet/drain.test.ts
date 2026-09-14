import { describe, expect, it, vi } from 'vitest';
import { createDrain, deployWaveSize, type DrainDeps, type InFlightEntry } from './drain.js';

/**
 * drain.test.ts (P09 U4 step 7) - `createDrain`'s FIXED sequence (pure
 * port-ordering, no real DB/socket) plus `deployWaveSize`'s formula. The two
 * DB-backed integration behaviors (the real `needs_reconcile` transition,
 * and the 45s/20s deadline proof against real ports) live in
 * `drain.integration.test.ts`.
 */

function makeDeps(overrides: Partial<DrainDeps> = {}): DrainDeps {
  return {
    beginDrain: vi.fn(),
    stopClaiming: vi.fn(async () => undefined),
    inFlight: {
      list: vi.fn((): InFlightEntry[] => []),
      awaitQuiescence: vi.fn(async () => undefined),
    },
    markNeedsReconcile: vi.fn(async () => undefined),
    sessions: [],
    closePools: vi.fn(async () => undefined),
    exit: vi.fn(),
    ...overrides,
  };
}

describe('deployWaveSize', () => {
  it('canon_10k_fleet_at_135_per_worker_is_one_worker_per_wave', () => {
    expect(deployWaveSize(10_000, 135)).toBe(1);
  });

  it('never_goes_below_one', () => {
    expect(deployWaveSize(1, 1000)).toBe(1);
  });

  it('floors_the_result', () => {
    // 10000 * 0.02 = 200; 200 / 60 = 3.33 -> floor 3.
    expect(deployWaveSize(10_000, 60)).toBe(3);
  });
});

describe('createDrain sequencing', () => {
  it('runs_the_fixed_sequence_beginDrain_stopClaiming_awaitQuiescence_flush_end_release_closePools_exit', async () => {
    const calls: string[] = [];
    const session = {
      instanceId: 'inst-1',
      flushCreds: vi.fn(async () => {
        calls.push('flushCreds:inst-1');
      }),
      endSocket: vi.fn(() => {
        calls.push('endSocket:inst-1');
      }),
      releaseLease: vi.fn(async () => {
        calls.push('releaseLease:inst-1');
      }),
    };

    const deps = makeDeps({
      beginDrain: vi.fn(() => {
        calls.push('beginDrain');
      }),
      stopClaiming: vi.fn(async () => {
        calls.push('stopClaiming');
      }),
      inFlight: {
        list: vi.fn((): InFlightEntry[] => []),
        awaitQuiescence: vi.fn(async () => {
          calls.push('awaitQuiescence');
        }),
      },
      sessions: [session],
      closePools: vi.fn(async () => {
        calls.push('closePools');
      }),
      exit: vi.fn((code: number) => {
        calls.push(`exit:${code}`);
      }),
    });

    const drain = createDrain(deps);
    await drain.run();

    expect(calls).toEqual([
      'beginDrain',
      'stopClaiming',
      'awaitQuiescence',
      'flushCreds:inst-1',
      'endSocket:inst-1',
      'releaseLease:inst-1',
      'closePools',
      'exit:0',
    ]);
  });

  it('leftover_in_flight_jobs_are_marked_needs_reconcile_never_a_blind_retry', async () => {
    const leftover: InFlightEntry = { jobId: 'job-1', instanceId: 'inst-1', clientId: 'client-1' };
    const markNeedsReconcile = vi.fn(async () => undefined);
    const deps = makeDeps({
      inFlight: {
        list: vi.fn((): InFlightEntry[] => [leftover]),
        awaitQuiescence: vi.fn(async () => undefined),
      },
      markNeedsReconcile,
    });

    const drain = createDrain(deps);
    await drain.run();

    expect(markNeedsReconcile).toHaveBeenCalledTimes(1);
    expect(markNeedsReconcile).toHaveBeenCalledWith(leftover);
  });

  it('a_flushCreds_failure_is_logged_and_does_not_abort_the_drain', async () => {
    const session = {
      instanceId: 'inst-1',
      flushCreds: vi.fn(async () => {
        throw new Error('flush failed');
      }),
      endSocket: vi.fn(),
      releaseLease: vi.fn(async () => undefined),
    };
    const errorLog = vi.fn();
    const exit = vi.fn();

    const deps = makeDeps({ sessions: [session], exit, logger: { error: errorLog } });
    const drain = createDrain(deps);
    await drain.run();

    expect(errorLog).toHaveBeenCalled();
    expect(session.endSocket).toHaveBeenCalledWith();
    expect(session.releaseLease).toHaveBeenCalledWith();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a_hung_port_cannot_push_the_drain_past_totalMs_best_effort_skip_and_still_reach_exit', async () => {
    const exit = vi.fn();
    const hungSession = {
      instanceId: 'inst-hung',
      flushCreds: vi.fn(() => new Promise<void>(() => undefined)), // never resolves
      endSocket: vi.fn(),
      releaseLease: vi.fn(async () => undefined),
    };

    const deps = makeDeps({
      sessions: [hungSession],
      exit,
      deadlines: { inFlightWaitMs: 5, totalMs: 20 },
    });

    const drain = createDrain(deps);
    await drain.run();

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('awaitQuiescence_is_passed_the_effective_budget_the_min_of_inFlightWaitMs_and_remaining_totalMs_never_the_raw_inFlightWaitMs', async () => {
    // C1 FINDING 3b regression: deadlines.inFlightWaitMs (20_000 in
    // production canon) can exceed what remainingMs() actually has left
    // when totalMs itself is small/already partly spent. The port must
    // receive the SAME effective budget withBudget races against - passing
    // it the raw inFlightWaitMs would let withBudget's timer fire first and
    // abandon the port's promise while it keeps running detached.
    let receivedDeadlineMs: number | undefined;
    const deps = makeDeps({
      inFlight: {
        list: vi.fn((): InFlightEntry[] => []),
        awaitQuiescence: vi.fn(async (deadlineMs: number) => {
          receivedDeadlineMs = deadlineMs;
        }),
      },
      // inFlightWaitMs (20_000) is far larger than totalMs (30) - remainingMs()
      // at step 3 is ~30ms, so the effective budget must be ~30, not 20_000.
      deadlines: { inFlightWaitMs: 20_000, totalMs: 30 },
    });

    const drain = createDrain(deps);
    await drain.run();

    // Invariant asserted, not a wall-clock margin: the effective budget must
    // never exceed totalMs (the smaller deadline) and must never equal the
    // raw inFlightWaitMs - exactly the min() the fix computes.
    expect(receivedDeadlineMs).toBeDefined();
    expect(receivedDeadlineMs).toBeLessThanOrEqual(deps.deadlines?.totalMs ?? 0);
    expect(receivedDeadlineMs).not.toBe(20_000);
  });
});
