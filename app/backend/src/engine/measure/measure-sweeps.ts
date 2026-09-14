import type { createPool, TenantDb } from '@wp/db';
import { TIMING } from '@wp/domain';
import { describeError } from '@wp/server-kit';
import { runOneReaperSweep, type ReaperDeps } from '../../modules/queue/reaper.js';
import { runOneReconcilerSweep, type ReconcilerDeps } from '../../modules/queue/reconciler.js';
import { bindQueueMetrics } from '../queue/metrics.js';
import { createCountingNoOpRepairedSendSink } from '../../modules/queue/repaired-send-sink.js';

/**
 * measure-sweeps.ts (P26 C1 fix round, FIX-B - "Additional finding") - a
 * shared reaper+reconciler helper for the measurement harnesses, mirroring
 * how `roles/cron.ts`/`engine/cron/cron-wiring.ts` construct `ReaperDeps`/
 * `ReconcilerDeps` for `ROLE=cron`.
 *
 * WHY THIS EXISTS: none of the measurement harnesses (`run-pacing.ts`,
 * `run-pg-load.ts`) run any reaper/reconciler sweep. A live 100,000-send load
 * run left 20 jobs stuck in `processing` with an EXPIRED claim lease (their
 * iteration had hit `DispatchAlreadyRecorded`) - with nothing requeuing an
 * expired claim, `waitForDrain`/`waitUntilJobsSettled` can never reach zero
 * without a human running `wp_reap_expired_leases` by hand. Production always
 * runs both sweeps from `roles/cron.ts` (reaper 15s, reconciler 30s +/-
 * jitter) - a measurement run that omits them is measuring a topology that
 * does not exist in production.
 *
 * DEPS: the real `bindQueueMetrics()` (harmless - a fresh/shared Prometheus
 * registry counter, never money) and `createCountingNoOpRepairedSendSink()`
 * (counts repairs without ever touching the wallet - a measurement run must
 * never charge real money for a synthetic repaired send). Both sweeps run on
 * PRODUCTION cadence (`TIMING.reaperIntervalMs`/`TIMING.reconcilerIntervalMs`)
 * via `unref()`'d intervals so they never keep the harness process alive on
 * their own, and `stop()` clears both timers deterministically.
 *
 * MINOR f fix (FIX-P26-H, 2026-09-07): the reaper's own `acked -> sent`
 * repair AND the reconciler's `applyResolve` both drive the SAME
 * `RepairedSendSink.onRepairedSent` call - it is the one money seam both
 * sweeps share. `reconcilerResolved` used to derive its delta from that
 * ONE sink shared by both independently-scheduled sweeps, so a reaper
 * repair landing between the reconciler tick's `beforeResolved` snapshot
 * and its own completion was silently counted as a reconciler resolution.
 * Each sweep now gets its OWN `CountingRepairedSendSink` instance
 * (`reaperSink`/`reconcilerSink`) - a reaper repair can only ever land in
 * `reaperSink.repairedSentCalls`, never `reconcilerSink`'s.
 */

export interface MeasureSweepsCounts {
  /** Total `wp_reaper_repairs_total` increments observed across every sweep tick so far, summed over every outcome label. */
  reaperRepairs: number;
  /** Total rows the reconciler resolved this run - the sink's own `onRepairedSent` call count (an `acked`-repair AND a reconciler `resolve` both drive this same real sink call). */
  reconcilerResolved: number;
  /** Total rows the reconciler moved to `blocked_needs_review` this run (`wp_reconcile_ambiguous_total`'s own delta - the `ambiguous` branch; `expired` emits no counter today and is not double-counted here). */
  reconcilerBlocked: number;
}

/** Sums every label's current value for one prom-client counter - used to derive a since-`start()` delta without adding new instrumentation to the reaper/reconciler modules themselves (out of this fix's scope). */
async function counterTotal(counter: {
  get(): Promise<{ values: { value: number }[] }>;
}): Promise<number> {
  const snapshot = await counter.get();
  return snapshot.values.reduce((sum, v) => sum + v.value, 0);
}

export interface CreateMeasureSweepsDeps {
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  /** Injectable so a unit test can fake sweep timing without a real interval. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /** Injectable so a unit test can fake a sweep tick without a real database (MINOR f fix's own unit test). */
  runOneReaperSweep?: typeof runOneReaperSweep;
  runOneReconcilerSweep?: typeof runOneReconcilerSweep;
}

export interface MeasureSweeps {
  /** Starts both sweeps immediately, then on production cadence. */
  start(): void;
  /** Clears both intervals - idempotent, safe to call without a prior `start()`. */
  stop(): void;
  /** Running totals since `start()` - read at any time, including after `stop()`. */
  counts(): MeasureSweepsCounts;
}

/**
 * Builds one reaper + one reconciler sweep pair wired against real deps, on
 * PRODUCTION cadence, for a measurement harness. Errors from either sweep are
 * logged to `console.error` and never thrown into the interval callback (an
 * unhandled rejection in a `setInterval` callback would crash the harness
 * process, exactly the CRITICAL 1 hazard FIX-A addresses in the runner) - a
 * failed tick simply retries on the next one.
 */
export function createMeasureSweeps(deps: CreateMeasureSweepsDeps): MeasureSweeps {
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const runReaperSweep = deps.runOneReaperSweep ?? runOneReaperSweep;
  const runReconcilerSweep = deps.runOneReconcilerSweep ?? runOneReconcilerSweep;
  const metrics = bindQueueMetrics();
  // Two INDEPENDENT sinks (MINOR f fix, see this file's own header) - a
  // reaper repair can only ever be recorded on `reaperSink`, never
  // `reconcilerSink`, so `reconcilerResolved` can never attribute a
  // concurrent reaper repair to the reconciler.
  const reaperSink = createCountingNoOpRepairedSendSink();
  const reconcilerSink = createCountingNoOpRepairedSendSink();

  const counts: MeasureSweepsCounts = {
    reaperRepairs: 0,
    reconcilerResolved: 0,
    reconcilerBlocked: 0,
  };

  const reaperDeps: ReaperDeps = {
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    metrics,
    sink: reaperSink,
    graceSeconds: Math.floor(TIMING.reaperGraceMs / 1000),
    limit: 500,
    rng: { random: () => Math.random() },
  };

  const reconcilerDeps: ReconcilerDeps = {
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    metrics,
    sink: reconcilerSink,
    reconcileWindowMs: TIMING.reconcileWindowMs,
    echoToleranceMs: TIMING.echoToleranceMs,
    maxRows: 500,
    now: () => Date.now(),
  };

  let reaperTimer: ReturnType<typeof setInterval> | undefined;
  let reconcilerTimer: ReturnType<typeof setInterval> | undefined;

  async function tickReaper(): Promise<void> {
    const before = await counterTotal(metrics.reaperRepairsTotal);
    try {
      await runReaperSweep(reaperDeps);
    } catch (err) {
      console.error(`measure-sweeps: reaper sweep failed: ${describeError(err)}`);
      return;
    }
    const after = await counterTotal(metrics.reaperRepairsTotal);
    counts.reaperRepairs += after - before;
  }

  async function tickReconciler(): Promise<void> {
    const beforeResolved = reconcilerSink.repairedSentCalls.length;
    const beforeAmbiguous = await counterTotal(metrics.reconcileAmbiguousTotal);
    try {
      await runReconcilerSweep(reconcilerDeps);
    } catch (err) {
      console.error(`measure-sweeps: reconciler sweep failed: ${describeError(err)}`);
      return;
    }
    // `applyResolve` (reconciler-resolve.ts) drives the same KIND of sink
    // call the reaper's `acked -> sent` repair does, but on `reconcilerSink`
    // - its OWN sink, never shared with the reaper's `reaperSink` (MINOR f
    // fix) - so this delta can never attribute a reaper repair to the
    // reconciler. Resolved rows are counted from the sink's own delta, never
    // a harness tally (invariant 7).
    counts.reconcilerResolved += reconcilerSink.repairedSentCalls.length - beforeResolved;
    const afterAmbiguous = await counterTotal(metrics.reconcileAmbiguousTotal);
    counts.reconcilerBlocked += afterAmbiguous - beforeAmbiguous;
  }

  return {
    start(): void {
      void tickReaper();
      void tickReconciler();
      reaperTimer = setIntervalFn(() => void tickReaper(), TIMING.reaperIntervalMs);
      reaperTimer.unref?.();
      reconcilerTimer = setIntervalFn(() => void tickReconciler(), TIMING.reconcilerIntervalMs);
      reconcilerTimer.unref?.();
    },
    stop(): void {
      if (reaperTimer) clearIntervalFn(reaperTimer);
      if (reconcilerTimer) clearIntervalFn(reconcilerTimer);
      reaperTimer = undefined;
      reconcilerTimer = undefined;
    },
    counts(): MeasureSweepsCounts {
      return { ...counts };
    },
  };
}
