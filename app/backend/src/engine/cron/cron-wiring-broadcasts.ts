import type { TenantDb } from '@wp/db';
import {
  createExpansionBudget,
  createFunnelActiveCursor,
  runOneBroadcastExpansionSweep,
  runOneBroadcastSnapshotSweep,
  runOneCancelBookkeepingSweep,
  runOneFunnelRecomputeSweep,
  type CancelBookkeepingSweepDeps,
  type ExpansionBudget,
  type ExpansionSweepDeps,
  type SnapshotSweepDeps,
} from '../../modules/broadcasts/index.js';
import type { BroadcastMetricsHandles } from '../../platform/metrics/broadcast-metrics.js';
import { CRON_LOCK_KEYS, runWithSingleFlightLock } from './single-flight.js';
import { createCronLoop, type CronLoop, type CronTickOutcome } from './cron-loop.js';
import type { CronWiringPool } from './cron-wiring.js';

/**
 * cron-wiring-broadcasts.ts (P23 Unit U4, steps 4/5/CRON; P23 Unit U5, step
 * 6 adds the third loop; P23 Unit U6b wires the workers' `onBatch` hooks
 * into `bindBroadcastMetrics()`'s handles - U6 registered the metrics but
 * never incremented them) - composes the broadcast snapshot + expansion +
 * cancel-bookkeeping sweep cadences on top of `cron-loop.ts`/
 * `single-flight.ts`, same split idiom as `cron-wiring-contacts.ts`. The
 * snapshot/expansion loops share ONE `ExpansionBudget` instance (fleet-wide
 * token bucket, ~5,000 rows/s) for the whole deployment - `
 * createBroadcastCronLoops` builds it once and threads it into both sweeps
 * (only the expansion sweep actually spends tokens; neither the snapshot nor
 * the cancel-bookkeeping sweep touches the budget - a cancel-bookkeeping
 * batch's rows were already durably queued, this sweep only stamps their
 * terminal status, never inserts a new `message_jobs` row).
 *
 * Cadence: 2s for snapshot/expansion, same as the contact-import sweep (a
 * local constant here, not `@wp/domain`'s `TIMING` - this unit does not own
 * that package's file). The cancel-bookkeeping loop uses its OWN, slower
 * 30s cadence (P23 C1 fix round, unit F1): bookkeeping is never the
 * enforcement point (the claim predicate is - see `cancel-bookkeeping.ts`'s
 * own header), so it never needs the same tight cadence the two engine
 * loops that actually gate claimable work do.
 *
 * P23a Unit U2 adds two more cadences for the progress-funnel recompute
 * sweep: `funnelActiveLoop` at 5s (the live funnel's own refresh floor -
 * one index-only `campaign_recipients` aggregate per active campaign, and
 * `campaign.progress` fires at most once per tick per campaign, so 5s
 * bounds both the DB cost and the SSE fanout rate) and `funnelHourlyLoop`
 * at 1 hour with the same `interval/12` jitter `walletRollupLoop`/
 * `walletReconcileLoop` use (crash reconciliation for rows the active loop
 * no longer visits - a terminal campaign whose counters were never
 * reconciled because a crash landed before the active loop's first tick).
 */

/** Local cadence constant - 2s, same as `TIMING.contactImportTickMs`. Kept local (not added to `@wp/domain`'s `TIMING`) since this unit does not own that package's files. */
const BROADCAST_SWEEP_INTERVAL_MS = 2_000;

/** P23 C1 fix round, unit F1 - the cancel-bookkeeping loop's own, slower cadence: it only makes an already-stopped campaign's rows visibly consistent, never the enforcement point, so it does not need the engine loops' 2s tightness. */
const CANCEL_BOOKKEEPING_SWEEP_INTERVAL_MS = 30_000;

/** P23a Unit U2 - the progress-funnel active-campaign recompute cadence: the live funnel's own refresh floor. */
const FUNNEL_ACTIVE_SWEEP_INTERVAL_MS = 5_000;

/** P23a Unit U2 - the progress-funnel hourly crash-reconciliation cadence, same order of magnitude as `TIMING.walletRollupIntervalMs`. */
const FUNNEL_HOURLY_SWEEP_INTERVAL_MS = 3_600_000;

export interface CreateBroadcastCronLoopsDeps {
  pool: CronWiringPool;
  tenantDb: TenantDb;
  rng?: { random: () => number };
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  logOutcome: (loopName: string, outcome: CronTickOutcome, error?: unknown) => void;
  /** Injectable for tests - defaults to a real `createExpansionBudget({ ratePerSecond: 5_000, burst: 5_000, clock: Date.now })`. */
  expansionBudget?: ExpansionBudget;
  /** Optional (P23 Unit U6b) - when supplied, wires each sweep's `onBatch` hook into these handles. Omitted so every existing cron-wiring*.test.ts keeps compiling. */
  metrics?: BroadcastMetricsHandles;
}

/** Builds the snapshot sweep's `onBatch` - one increment per status the batch actually wrote, exact counts, never a bound. */
export function buildSnapshotOnBatch(
  metrics: BroadcastMetricsHandles,
): NonNullable<SnapshotSweepDeps['onBatch']> {
  return (info) => {
    metrics.incrementRecipients('pending', info.pending);
    metrics.incrementRecipients('skipped', info.skipped);
  };
}

/** Builds the expansion sweep's `onBatch` - `queued`/`failed` recipient increments plus at most one lag observation per batch (skipped when the campaign has no `snapshot_done_at` yet). */
export function buildExpansionOnBatch(
  metrics: BroadcastMetricsHandles,
): NonNullable<ExpansionSweepDeps['onBatch']> {
  return (info) => {
    metrics.incrementRecipients('queued', info.inserted);
    metrics.incrementRecipients('failed', info.renderFailed);
    if (info.lagSeconds !== undefined) {
      metrics.observeExpansionLagSeconds(info.lagSeconds);
    }
  };
}

/** Builds the cancel-bookkeeping sweep's `onBatch` - one increment for the recipients that batch stamped `cancelled`. */
export function buildCancelBookkeepingOnBatch(
  metrics: BroadcastMetricsHandles,
): NonNullable<CancelBookkeepingSweepDeps['onBatch']> {
  return (info) => {
    metrics.incrementRecipients('cancelled', info.cancelledRecipients);
  };
}

export interface BroadcastCronLoops {
  snapshotLoop: CronLoop;
  expansionLoop: CronLoop;
  /** P23 Unit U5, step 6 - the resumable cancel-bookkeeping stamping sweep (never the enforcement point, see `cancel-bookkeeping.ts`'s own header). */
  cancelBookkeepingLoop: CronLoop;
  /** P23a Unit U2 - the progress-funnel active-campaign recompute sweep (5s cadence, see this module's own header). */
  funnelActiveLoop: CronLoop;
  /** P23a Unit U2 - the progress-funnel hourly crash-reconciliation sweep. */
  funnelHourlyLoop: CronLoop;
}

/** Starts every loop `createBroadcastCronLoops` built - replaces the three (now five) per-loop `.start()` calls `cron-wiring.ts` used to inline. */
export function startBroadcastCronLoops(loops: BroadcastCronLoops): void {
  loops.snapshotLoop.start();
  loops.expansionLoop.start();
  loops.cancelBookkeepingLoop.start();
  loops.funnelActiveLoop.start();
  loops.funnelHourlyLoop.start();
}

/** Stops every loop `createBroadcastCronLoops` built - see `startBroadcastCronLoops` above. */
export function stopBroadcastCronLoops(loops: BroadcastCronLoops): void {
  loops.snapshotLoop.stop();
  loops.expansionLoop.stop();
  loops.cancelBookkeepingLoop.stop();
  loops.funnelActiveLoop.stop();
  loops.funnelHourlyLoop.stop();
}

/** Builds the three broadcast sweep loops: single-flighted; snapshot/expansion share one fleet-wide expansion budget at the 2s cadence, cancel-bookkeeping runs its own slower 30s cadence (P23 C1 fix round, unit F1). */
export function createBroadcastCronLoops(deps: CreateBroadcastCronLoopsDeps): BroadcastCronLoops {
  const budget =
    deps.expansionBudget ??
    createExpansionBudget({ ratePerSecond: 5_000, burst: 5_000, clock: { now: () => Date.now() } });
  const snapshotOnBatch = deps.metrics ? buildSnapshotOnBatch(deps.metrics) : undefined;
  const expansionOnBatch = deps.metrics ? buildExpansionOnBatch(deps.metrics) : undefined;
  const cancelBookkeepingOnBatch = deps.metrics
    ? buildCancelBookkeepingOnBatch(deps.metrics)
    : undefined;

  const snapshotLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.broadcastSnapshot, async () => {
        await runOneBroadcastSnapshotSweep({
          pool: deps.pool,
          tenantDb: deps.tenantDb,
          onBatch: snapshotOnBatch,
        });
      }),
    intervalMs: BROADCAST_SWEEP_INTERVAL_MS,
    rng: deps.rng,
    onOutcome: (outcome, error) => {
      deps.logOutcome('broadcast-snapshot', outcome, error);
    },
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  const expansionLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.broadcastExpansion, async () => {
        await runOneBroadcastExpansionSweep({
          pool: deps.pool,
          tenantDb: deps.tenantDb,
          budget,
          onBatch: expansionOnBatch,
        });
      }),
    intervalMs: BROADCAST_SWEEP_INTERVAL_MS,
    rng: deps.rng,
    onOutcome: (outcome, error) => {
      deps.logOutcome('broadcast-expansion', outcome, error);
    },
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  const cancelBookkeepingLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.broadcastCancelBookkeeping, async () => {
        await runOneCancelBookkeepingSweep({
          pool: deps.pool,
          tenantDb: deps.tenantDb,
          onBatch: cancelBookkeepingOnBatch,
        });
      }),
    intervalMs: CANCEL_BOOKKEEPING_SWEEP_INTERVAL_MS,
    rng: deps.rng,
    onOutcome: (outcome, error) => {
      deps.logOutcome('broadcast-cancel-bookkeeping', outcome, error);
    },
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  // P23a C1 fix round unit F2 - ONE cursor instance shared across every
  // active-loop tick for this process's lifetime, so the keyset rotation
  // actually rotates tick over tick (a fresh per-call cursor would restart
  // from the zero uuid every 5s and never progress past the first LIMIT
  // rows - see funnel.sweep.ts's own header).
  const funnelActiveCursor = createFunnelActiveCursor();

  const funnelActiveLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.broadcastFunnelActive, async () => {
        await runOneFunnelRecomputeSweep({
          pool: deps.pool,
          tenantDb: deps.tenantDb,
          mode: 'active',
          activeCursor: funnelActiveCursor,
        });
      }),
    intervalMs: FUNNEL_ACTIVE_SWEEP_INTERVAL_MS,
    rng: deps.rng,
    onOutcome: (outcome, error) => {
      deps.logOutcome('broadcast-funnel-active', outcome, error);
    },
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  const funnelHourlyLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.broadcastFunnelHourly, async () => {
        await runOneFunnelRecomputeSweep({
          pool: deps.pool,
          tenantDb: deps.tenantDb,
          mode: 'hourly',
        });
      }),
    intervalMs: FUNNEL_HOURLY_SWEEP_INTERVAL_MS,
    jitterMs: Math.round(FUNNEL_HOURLY_SWEEP_INTERVAL_MS / 12),
    rng: deps.rng,
    onOutcome: (outcome, error) => {
      deps.logOutcome('broadcast-funnel-hourly', outcome, error);
    },
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  return {
    snapshotLoop,
    expansionLoop,
    cancelBookkeepingLoop,
    funnelActiveLoop,
    funnelHourlyLoop,
  };
}
