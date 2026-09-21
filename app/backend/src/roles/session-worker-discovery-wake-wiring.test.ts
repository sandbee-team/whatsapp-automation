import '../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { bootDiscoveryScanScheduler } from './session-worker-discovery-wake-wiring.js';

/**
 * session-worker-discovery-wake-wiring.test.ts (2026-09-17, "QR takes
 * 3-12s to appear" fix) - proves the scan scheduler's two hard requirements
 * from the fix's own brief: (1) the 5s+/-2s poll keeps running completely
 * unconditionally, NEVER made conditional on the wake ever firing, and (2) a
 * received wake cancels the currently-pending timer and runs a scan
 * immediately instead of waiting out the rest of the interval - without
 * ever starting a SECOND, overlapping scan while one is already in flight.
 */

function fakeRedisCtl(): {
  redisCtl: Pick<Redis, 'duplicate'>;
  emit: (channel: string) => void;
  subscribeCalls: string[];
} {
  let handler: ((channel: string) => void) | undefined;
  const subscribeCalls: string[] = [];
  const duplicated = {
    on: vi.fn((_event: string, cb: (channel: string) => void) => {
      handler = cb;
    }),
    off: vi.fn(),
    subscribe: vi.fn(async (channel: string) => {
      subscribeCalls.push(channel);
    }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  };
  return {
    // Same cast idiom `send-loop-worker-wiring.test.ts` already uses for its
    // own `redisCtl: { duplicate: () => ({}) } as never` fakes - `duplicated`
    // only implements the handful of `Redis` methods this subscriber calls,
    // never the full interface.
    redisCtl: { duplicate: vi.fn(() => duplicated) } as never as Pick<Redis, 'duplicate'>,
    emit: (channel: string) => handler?.(channel),
    subscribeCalls,
  };
}

describe('bootDiscoveryScanScheduler', () => {
  it('polls_on_its_own_unconditional_interval_even_if_no_wake_ever_arrives', async () => {
    vi.useFakeTimers();
    try {
      const runOneScanIteration = vi.fn().mockResolvedValue(undefined);
      const reconcile = vi.fn().mockResolvedValue(undefined);
      const { redisCtl } = fakeRedisCtl();
      const scheduler = bootDiscoveryScanScheduler({
        env: 'test',
        redisCtl,
        worker: { runOneScanIteration },
        sendLoopWiring: { reconcile },
        logger: { error: vi.fn() },
        random: () => 0.5, // exact 5000ms interval (no jitter at the midpoint)
      });

      await scheduler.start();
      expect(runOneScanIteration).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      expect(runOneScanIteration).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(runOneScanIteration).toHaveBeenCalledTimes(2);

      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a_wake_cancels_the_pending_timer_and_runs_a_scan_immediately', async () => {
    vi.useFakeTimers();
    try {
      const runOneScanIteration = vi.fn().mockResolvedValue(undefined);
      const reconcile = vi.fn().mockResolvedValue(undefined);
      const { redisCtl, emit, subscribeCalls } = fakeRedisCtl();
      const scheduler = bootDiscoveryScanScheduler({
        env: 'test',
        redisCtl,
        worker: { runOneScanIteration },
        sendLoopWiring: { reconcile },
        logger: { error: vi.fn() },
        random: () => 0.5,
      });

      await scheduler.start();
      expect(subscribeCalls).toEqual(['wp:test:discovery:wake']);

      // Only 1000ms of the 5000ms interval has elapsed - without the wake,
      // this would not run for another 4000ms.
      await vi.advanceTimersByTimeAsync(1000);
      expect(runOneScanIteration).not.toHaveBeenCalled();

      emit('wp:test:discovery:wake');
      await vi.advanceTimersByTimeAsync(0);
      expect(runOneScanIteration).toHaveBeenCalledTimes(1);

      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a_wake_arriving_while_a_scan_is_already_in_flight_never_starts_a_second_overlapping_scan', async () => {
    vi.useFakeTimers();
    try {
      let resolveScan: (() => void) | undefined;
      const runOneScanIteration = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveScan = resolve;
          }),
      );
      const reconcile = vi.fn().mockResolvedValue(undefined);
      const { redisCtl, emit } = fakeRedisCtl();
      const scheduler = bootDiscoveryScanScheduler({
        env: 'test',
        redisCtl,
        worker: { runOneScanIteration },
        sendLoopWiring: { reconcile },
        logger: { error: vi.fn() },
        random: () => 0.5,
      });

      await scheduler.start();
      await vi.advanceTimersByTimeAsync(5000);
      expect(runOneScanIteration).toHaveBeenCalledTimes(1); // now in flight, unresolved

      // A wake arrives while the first scan is still running.
      emit('wp:test:discovery:wake');
      await Promise.resolve();
      expect(runOneScanIteration).toHaveBeenCalledTimes(1); // still just the one - no overlap

      // Same microtask-flush idiom as send-loop-fleet-wiring.test.ts: resolve
      // the manually-controlled scan promise, then flush the `.then(reconcile)
      // .finally(...)` chain that hangs off it.
      resolveScan?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(reconcile).toHaveBeenCalledTimes(1);

      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop_prevents_any_further_scan_even_if_a_wake_arrives_after', async () => {
    vi.useFakeTimers();
    try {
      const runOneScanIteration = vi.fn().mockResolvedValue(undefined);
      const reconcile = vi.fn().mockResolvedValue(undefined);
      const { redisCtl, emit } = fakeRedisCtl();
      const scheduler = bootDiscoveryScanScheduler({
        env: 'test',
        redisCtl,
        worker: { runOneScanIteration },
        sendLoopWiring: { reconcile },
        logger: { error: vi.fn() },
        random: () => 0.5,
      });

      await scheduler.start();
      await scheduler.stop();

      emit('wp:test:discovery:wake');
      await vi.advanceTimersByTimeAsync(10_000);

      expect(runOneScanIteration).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
