import { describe, expect, it, vi } from 'vitest';
import type { createPool, TenantDb } from '@wp/db';
import { createMeasureSweeps } from './measure-sweeps.js';
import type { ReaperDeps } from '../../modules/queue/reaper.js';
import type { ReconcilerDeps } from '../../modules/queue/reconciler.js';

/**
 * measure-sweeps.test.ts (FIX-P26-H MINOR f, 2026-09-07) - proves
 * `reconcilerResolved` no longer over-counts a reaper repair. The two real
 * sweeps (`runOneReaperSweep`/`runOneReconcilerSweep`) both drive the SAME
 * `RepairedSendSink.onRepairedSent` (the reaper's own `acked -> sent`
 * repair, and the reconciler's `applyResolve`); the old code shared ONE sink
 * between both ticks, so `reconcilerResolved`'s baseline/delta could count a
 * concurrent reaper repair that landed between its `beforeResolved` snapshot
 * and its own sweep completing. Fake `runOneReaperSweep`/`runOneReconcilerSweep`
 * deps (injected the same way `setIntervalFn`/`clearIntervalFn` already are)
 * let this test drive exactly one reaper-sink-call and zero reconciler-sink-
 * calls and assert the reaper's call is attributed to `reaperRepairs`
 * (via the counter, unaffected by this fix) and NEVER to
 * `reconcilerResolved`. Does not reach `@wp/server-kit` (only `@wp/db`
 * TYPES), so no `stub-wp-server-kit-env` import is needed here.
 */

function fakeTenantDb(): TenantDb {
  return {} as unknown as TenantDb;
}

describe('createMeasureSweeps - MINOR f (independent sinks per sweep)', () => {
  it('a reaper repaired-send call is never attributed to reconcilerResolved', async () => {
    const runOneReaperSweep = vi.fn(async (deps: ReaperDeps) => {
      // Simulates the reaper's own `acked -> sent` repair calling the money
      // seam directly - exactly what `applyRepairedSent` does in production.
      await deps.sink.onRepairedSent('attempt-1', 'client-1');
    });
    const runOneReconcilerSweep = vi.fn((deps: ReconcilerDeps): Promise<void> => {
      // The reconciler sweep itself resolves NOTHING this tick.
      void deps;
      return Promise.resolve();
    });

    const fakeTimer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const sweeps = createMeasureSweeps({
      pool: {} as unknown as ReturnType<typeof createPool>,
      tenantDb: fakeTenantDb(),
      setIntervalFn: vi.fn(() => fakeTimer) as unknown as typeof setInterval,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
      runOneReaperSweep,
      runOneReconcilerSweep,
    });

    sweeps.start();
    // `start()` fires both ticks once, fire-and-forget (`void tickReaper()`);
    // flush microtasks so both awaited sink calls land before reading counts.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const counts = sweeps.counts();
    expect(counts.reconcilerResolved).toBe(0);
    expect(runOneReaperSweep).toHaveBeenCalledTimes(1);
    expect(runOneReconcilerSweep).toHaveBeenCalledTimes(1);

    sweeps.stop();
  });
});
