import { describe, expect, it, vi } from 'vitest';
import { createFleetConnectGate, ConnectGateAbortedError } from './connect-budget.js';

/**
 * connect-budget-gate.test.ts (P09 Unit U2 step 4, FIX-P09-B split) - the
 * fleet gate's composition (per-worker AND fleet token) and CRITICAL 3
 * (FIX-P09-A) abort/cancellation cases, split out of `connect-budget.test.ts`
 * at FIX-P09-B for the max-lines cap (topic split only - same cases,
 * unchanged), against a FAKE Redis client - no real Redis here.
 */

describe('createFleetConnectGate', () => {
  function makeFakeFleetBucket(takeResults: boolean[]) {
    let i = 0;
    return {
      take: vi.fn(async () => {
        const result = takeResults[i] ?? true;
        i += 1;
        return result;
      }),
    };
  }

  it('take_consumes_both_the_per_worker_and_fleet_token', async () => {
    const perWorkerTake = vi.fn(async () => {});
    const fleetBucket = makeFakeFleetBucket([true]);
    const onWait = vi.fn();

    const gate = createFleetConnectGate({
      perWorkerGate: { take: perWorkerTake },
      fleetBucket,
      onWait,
      sleepMs: vi.fn(async () => {}),
    });

    await gate.take();

    expect(perWorkerTake).toHaveBeenCalledTimes(1);
    expect(fleetBucket.take).toHaveBeenCalledTimes(1);
  });

  it('retries_the_fleet_token_and_records_wait_time_when_the_bucket_is_empty', async () => {
    const perWorkerTake = vi.fn(async () => {});
    const fleetBucket = makeFakeFleetBucket([false, false, true]);
    const onWait = vi.fn();
    const sleepMs = vi.fn(async () => {});

    const gate = createFleetConnectGate({
      perWorkerGate: { take: perWorkerTake },
      fleetBucket,
      onWait,
      sleepMs,
    });

    await gate.take();

    expect(fleetBucket.take).toHaveBeenCalledTimes(3);
    expect(sleepMs).toHaveBeenCalledTimes(2);
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(onWait).toHaveBeenCalledWith(expect.any(Number));
    const [waitSeconds] = onWait.mock.calls[0] as [number];
    expect(waitSeconds).toBeGreaterThan(0);
  });

  it('a_fleet_token_error_never_bypasses_the_gate', async () => {
    const perWorkerTake = vi.fn(async () => {});
    const fleetBucket = {
      take: vi.fn(async () => {
        throw new Error('redis unreachable');
      }),
    };
    const onWait = vi.fn();

    const gate = createFleetConnectGate({
      perWorkerGate: { take: perWorkerTake },
      fleetBucket,
      onWait,
      sleepMs: vi.fn(async () => {}),
    });

    await expect(gate.take()).rejects.toThrow('redis unreachable');
  });

  // -------------------------------------------------------------------
  // CRITICAL 3 (FIX-P09-A): unbounded/uncancellable fleet-gate take().
  // -------------------------------------------------------------------

  it('an already-aborted signal rejects immediately with ConnectGateAbortedError, never spending the per-worker token on a parked retry', async () => {
    const perWorkerTake = vi.fn(async () => {});
    const fleetBucket = { take: vi.fn(async () => false) };
    const onWait = vi.fn();
    const sleepMs = vi.fn(async () => {});

    const gate = createFleetConnectGate({
      perWorkerGate: { take: perWorkerTake },
      fleetBucket,
      onWait,
      sleepMs,
    });

    const controller = new AbortController();
    controller.abort();

    await expect(gate.take({ signal: controller.signal })).rejects.toBeInstanceOf(
      ConnectGateAbortedError,
    );
    expect(perWorkerTake).not.toHaveBeenCalled();
    expect(fleetBucket.take).not.toHaveBeenCalled();
  });

  it('aborting mid-retry rejects promptly with ConnectGateAbortedError and closes out the bounded wait observation instead of parking forever', async () => {
    const perWorkerTake = vi.fn(async () => {});
    const fleetBucket = { take: vi.fn(async () => false) };
    const onWait = vi.fn();
    const controller = new AbortController();
    let sleepCalls = 0;
    const sleepMs = vi.fn(async () => {
      sleepCalls += 1;
      if (sleepCalls === 3) {
        controller.abort();
      }
    });

    const gate = createFleetConnectGate({
      perWorkerGate: { take: perWorkerTake },
      fleetBucket,
      onWait,
      sleepMs,
    });

    await expect(gate.take({ signal: controller.signal })).rejects.toBeInstanceOf(
      ConnectGateAbortedError,
    );
    // The per-worker token WAS spent (spent before the fleet retry loop
    // starts) but the fleet bucket never granted a token - the abort
    // recorded a bounded wait sample rather than leaving it unobserved.
    expect(perWorkerTake).toHaveBeenCalledTimes(1);
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(onWait).toHaveBeenCalledWith(expect.any(Number));
  });

  it('an attempt-deadline rollover records a bounded wait observation and keeps waiting for a token (never gives up)', async () => {
    const perWorkerTake = vi.fn(async () => {});
    // Grants the token on the 5th attempt - well past a tiny 2-retry
    // attempt deadline, forcing at least one rollover.
    let calls = 0;
    const fleetBucket = {
      take: vi.fn(async () => {
        calls += 1;
        return calls >= 5;
      }),
    };
    const onWait = vi.fn();
    const sleepMs = vi.fn(async () => {});

    const gate = createFleetConnectGate({
      perWorkerGate: { take: perWorkerTake },
      fleetBucket,
      onWait,
      sleepMs,
      retryDelayMs: 100,
      // 2 retries (200ms) before a rollover - forces at least 2 rollovers
      // across the 4 failed attempts (400ms of waiting) before success.
      attemptDeadlineMs: 200,
    });

    await gate.take();

    expect(fleetBucket.take).toHaveBeenCalledTimes(5);
    // At least one bounded rollover observation, plus the final success
    // observation - never a single unbounded sample covering the whole
    // 400ms wait.
    expect(onWait.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [seconds] of onWait.mock.calls as [number][]) {
      expect(seconds).toBeLessThanOrEqual(0.2 + 1e-9);
    }
  });
});
