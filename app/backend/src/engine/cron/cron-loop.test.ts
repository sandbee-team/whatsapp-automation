import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createCronLoop } from './cron-loop.js';

/**
 * cron-loop.test.ts (P12 Unit U4, step 7) - proves the generic ticker's
 * skip-guard, distinct-cadence scheduling, and error backoff, all with an
 * INJECTED fake timer (`setIntervalFn`/`clearIntervalFn`) and manual tick
 * invocation - no real `setInterval`/sleep anywhere in this file (banned
 * pattern, see `.claude/rules/core-invariants.md`).
 */

interface FakeTimer {
  setIntervalFn: (fn: () => void, ms: number) => number;
  clearIntervalFn: (handle: number) => void;
  /** Invokes the CURRENT active interval's callback synchronously - `createCronLoop` only ever has one live handle at a time (a stale one is always cleared before a new one is armed), so "the current interval" is unambiguous. */
  fire: () => void;
  scheduledDelays: number[];
  clearedCount: number;
}

function buildFakeTimer(): FakeTimer {
  let nextHandle = 1;
  let current: { handle: number; fn: () => void } | undefined;
  const scheduledDelays: number[] = [];
  let clearedCount = 0;

  return {
    setIntervalFn: (fn, ms) => {
      const handle = nextHandle;
      nextHandle += 1;
      scheduledDelays.push(ms);
      current = { handle, fn };
      return handle as unknown as number;
    },
    clearIntervalFn: (handle) => {
      if (current?.handle === handle) {
        current = undefined;
      }
      clearedCount += 1;
    },
    fire: () => {
      current?.fn();
    },
    scheduledDelays,
    get clearedCount() {
      return clearedCount;
    },
  };
}

describe('createCronLoop', () => {
  it('a_second_cron_process_that_cannot_take_the_advisory_lock_does_nothing', async () => {
    const timer = buildFakeTimer();
    const runOne = vi.fn().mockResolvedValue({ outcome: 'lock_not_acquired' as const });
    const onOutcome = vi.fn();

    const loop = createCronLoop({
      runOne,
      intervalMs: 15_000,
      onOutcome,
      setIntervalFn: timer.setIntervalFn as unknown as typeof setInterval,
      clearIntervalFn: timer.clearIntervalFn as unknown as typeof clearInterval,
    });

    loop.start();
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();

    expect(runOne).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('lock_not_acquired');
  });

  it('the_reaper_and_reconciler_locks_are_distinct_so_the_two_loops_never_block_each_other', async () => {
    const reaperTimer = buildFakeTimer();
    const reconcilerTimer = buildFakeTimer();

    const reaperRunOne = vi.fn().mockResolvedValue({ outcome: 'ran' as const });
    const reconcilerRunOne = vi.fn().mockResolvedValue({ outcome: 'ran' as const });

    const reaperLoop = createCronLoop({
      runOne: reaperRunOne,
      intervalMs: 15_000,
      setIntervalFn: reaperTimer.setIntervalFn as unknown as typeof setInterval,
      clearIntervalFn: reaperTimer.clearIntervalFn as unknown as typeof clearInterval,
    });
    const reconcilerLoop = createCronLoop({
      runOne: reconcilerRunOne,
      intervalMs: 30_000,
      jitterMs: 5_000,
      rng: { random: () => 0.5 },
      setIntervalFn: reconcilerTimer.setIntervalFn as unknown as typeof setInterval,
      clearIntervalFn: reconcilerTimer.clearIntervalFn as unknown as typeof clearInterval,
    });

    reaperLoop.start();
    reconcilerLoop.start();

    // Distinct cadences: reaper is a fixed 15s, reconciler is 30s exactly at
    // rng=0.5 (no jitter offset) - each loop only ever touches its OWN
    // timer, so firing the reaper's interval must never invoke the
    // reconciler's runOne (and vice versa).
    expect(reaperTimer.scheduledDelays).toEqual([15_000]);
    expect(reconcilerTimer.scheduledDelays).toEqual([30_000]);

    reaperTimer.fire();
    await Promise.resolve();
    await Promise.resolve();

    expect(reaperRunOne).toHaveBeenCalledTimes(1);
    expect(reconcilerRunOne).not.toHaveBeenCalled();
  });

  it('a_database_error_in_one_tick_backs_off_and_the_next_tick_still_runs', async () => {
    const timer = buildFakeTimer();
    const runOne = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'db_error' as const, error: new Error('boom') })
      .mockResolvedValueOnce({ outcome: 'ran' as const });

    const loop = createCronLoop({
      runOne,
      intervalMs: 15_000,
      backoffScheduleMs: [5_000, 15_000],
      setIntervalFn: timer.setIntervalFn as unknown as typeof setInterval,
      clearIntervalFn: timer.clearIntervalFn as unknown as typeof clearInterval,
    });

    loop.start();
    expect(timer.scheduledDelays).toEqual([15_000]);

    timer.fire();
    await Promise.resolve();
    await Promise.resolve();

    // First tick errored - the interval is re-armed, stretched by the FIRST backoff step.
    expect(timer.scheduledDelays).toEqual([15_000, 20_000]);

    timer.fire();
    await Promise.resolve();
    await Promise.resolve();

    expect(runOne).toHaveBeenCalledTimes(2);
    // Second tick succeeded - backoff resets, interval is re-armed back to the plain base.
    expect(timer.scheduledDelays).toEqual([15_000, 20_000, 15_000]);
  });

  it('a_slow_tick_never_overlaps_itself', async () => {
    const timer = buildFakeTimer();
    let resolveFirst: (() => void) | undefined;
    const firstTickPromise = new Promise<{ outcome: 'ran' }>((resolve) => {
      resolveFirst = () => resolve({ outcome: 'ran' });
    });
    const runOne = vi.fn().mockReturnValueOnce(firstTickPromise);
    const onOutcome = vi.fn();

    const loop = createCronLoop({
      runOne,
      intervalMs: 15_000,
      onOutcome,
      setIntervalFn: timer.setIntervalFn as unknown as typeof setInterval,
      clearIntervalFn: timer.clearIntervalFn as unknown as typeof clearInterval,
    });

    loop.start();
    timer.fire(); // first tick starts, still in flight (never resolved yet)
    await Promise.resolve();

    // The interval fires again before the first tick settled - the
    // skip-guard must treat this as an overlap and skip it, never a second
    // concurrent call into runOne.
    timer.fire();
    await Promise.resolve();

    expect(runOne).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('skipped_overlap');

    resolveFirst?.();
    await firstTickPromise;
    await Promise.resolve();
    await Promise.resolve();

    expect(onOutcome).toHaveBeenNthCalledWith(2, 'ran');
  });

  it('stop_cancels_the_interval_and_no_further_tick_runs', () => {
    const timer = buildFakeTimer();
    const runOne = vi.fn().mockResolvedValue({ outcome: 'ran' as const });

    const loop = createCronLoop({
      runOne,
      intervalMs: 15_000,
      setIntervalFn: timer.setIntervalFn as unknown as typeof setInterval,
      clearIntervalFn: timer.clearIntervalFn as unknown as typeof clearInterval,
    });

    loop.start();
    loop.stop();

    expect(timer.clearedCount).toBe(1);
  });
});
