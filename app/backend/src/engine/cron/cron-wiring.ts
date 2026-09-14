import type { TenantDb } from '@wp/db';
import { TIMING } from '@wp/domain';
import { logger } from '@wp/server-kit';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { runOneReaperSweep, type ReaperDeps } from '../../modules/queue/reaper.js';
import { runOneReconcilerSweep, type ReconcilerDeps } from '../../modules/queue/reconciler.js';
import { bindQueueMetrics, type QueueMetricsHandles } from '../../engine/queue/metrics.js';
import {
  bindWalletMetrics,
  type WalletMetricsHandles,
} from '../../platform/metrics/wallet-metrics.js';
import { bindContactsMetrics } from '../../platform/metrics/contacts.js';
import { bindBroadcastMetrics } from '../../platform/metrics/broadcast-metrics.js';
import type { ObjectStore } from '../../platform/storage/object-store.js';
import { bindPacingMetrics } from '../pacing/metrics.js';
import { runOnePacingEvaluatorSweep, type WarmupMetrics } from '../pacing/warmup-evaluator.js';
import type { PacingEvaluatorPublish } from '../pacing/warmup-evaluator.js';
import { CRON_LOCK_KEYS, runWithSingleFlightLock } from './single-flight.js';
import { createCronLoop, type CronLoop, type CronTickOutcome } from './cron-loop.js';
import { createWalletCronLoops } from './cron-wiring-wallet.js';
import { createContactsCronLoops, type ContactsCronLoops } from './cron-wiring-contacts.js';
import { armMediaLoops, type MediaMaintenanceLoops } from './cron-wiring-media-maintenance.js';
import {
  createBroadcastCronLoops,
  startBroadcastCronLoops,
  stopBroadcastCronLoops,
  type BroadcastCronLoops,
} from './cron-wiring-broadcasts.js';
import { createEpochCronLoops, type EpochCronLoops } from './cron-wiring-epoch.js';
import { createAdminRelaxCronLoops, type AdminRelaxCronLoops } from './cron-wiring-admin-relax.js';
import { createRollupCronLoops, type RollupCronLoops } from './cron-wiring-rollups.js';
import { buildOutboxPacingPublish, type CronWiringPool } from './cron-wiring-pacing-publish.js';
import type { ChargerRedis } from '../../modules/wallet/index.js';

/** Re-exported for backward compatibility - see `cron-wiring-pacing-publish.ts` for the implementation. */
export { buildOutboxPacingPublish, type CronWiringPool } from './cron-wiring-pacing-publish.js';

/**
 * cron-wiring.ts - composes every `ROLE=cron` cadence on `single-flight.ts` +
 * `cron-loop.ts` (loadConfig -> pool -> `createCronWiring` -> `.start()`/
 * `.stop()`). Each loop's `runOne()` is `runWithSingleFlightLock(pool,
 * LOCK_KEY, fn)` - the lock guards CONCURRENCY ONLY, never the sweep's own
 * `tenantDb.withTenant` transactions.
 */

export interface CronWiringDeps {
  pool: CronWiringPool;
  tenantDb: TenantDb;
  metrics?: QueueMetricsHandles;
  rng?: { random: () => number };
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /** Defaults to `buildOutboxPacingPublish(deps.pool)` - a real outbox write, never a no-op. */
  pacingPublish?: PacingEvaluatorPublish;
  /** Defaults to the real `bindPacingMetrics().warmupMetrics`. */
  warmupMetrics?: WarmupMetrics;
  env?: string;
  /** Arms the wallet-charger drain loop when supplied (fail-safe default: omitted = none). */
  redis?: ChargerRedis;
  /** Defaults to the real `bindWalletMetrics()`. */
  walletMetrics?: WalletMetricsHandles;
  /** With `objectStore`, arms `contactsLoops`; `objectStore` alone also arms `mediaLoops`. */
  keyProvider?: KeyProvider;
  objectStore?: ObjectStore;
  /** The metric rollup collector's own cadence; defaults to `MIN_ROLLUP_INTERVAL_MS` (300_000). */
  metricRollupIntervalMs?: number;
}

export interface CronWiring {
  reaperLoop: CronLoop;
  reconcilerLoop: CronLoop;
  pacingEvaluatorLoop: CronLoop;
  /** Only defined when `deps.redis` is supplied. */
  chargerLoop?: CronLoop;
  walletRollupLoop: CronLoop;
  walletReconcileLoop: CronLoop;
  /** Only defined when both `deps.keyProvider` and `deps.objectStore` are supplied. */
  contactsLoops?: ContactsCronLoops;
  /** Only defined when `deps.objectStore` is supplied (no keyProvider needed). */
  mediaLoops?: MediaMaintenanceLoops;
  broadcastLoops: BroadcastCronLoops;
  epochLoops: EpochCronLoops;
  rollupLoops: RollupCronLoops;
  adminRelaxLoops: AdminRelaxCronLoops;
  start: () => void;
  stop: () => void;
}

/** Bounded batch size for both cross-tenant sweeps - never unbounded (repo-wide discipline). */
const SWEEP_MAX_ROWS = 500;

/** Bounded backoff schedule (ms) on consecutive DB errors - repeats the last entry, never grows unbounded. Exported so `cron-wiring-wallet.ts`'s two locked loops reuse it. */
export const DB_ERROR_BACKOFF_MS = [5_000, 15_000, 30_000];

/** Renders a `db_error` tick-failure log line - `name`/`code` ONLY, never `error.message` (a pg message can carry row values). */
export function logOutcome(loopName: string, outcome: CronTickOutcome, error?: unknown): void {
  if (outcome === 'db_error') {
    const name = error instanceof Error ? error.name : 'Error';
    const code = (error as { code?: unknown } | null)?.code;
    const suffix = code ? ` (${String(code)})` : '';
    logger.error({}, `cron ${loopName} tick failed, backing off: ${name}${suffix}`);
    return;
  }
  if (outcome === 'lock_not_acquired') {
    // A second cron process holds this loop's lock right now - a normal steady state, never an error-level log.
    return;
  }
  // 'ran' / 'skipped_overlap': no per-tick log line - metrics carry these.
}

export function createCronWiring(deps: CronWiringDeps): CronWiring {
  const metrics = deps.metrics ?? bindQueueMetrics();
  const walletMetrics = deps.walletMetrics ?? bindWalletMetrics();
  const walletLoops = createWalletCronLoops({
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    redis: deps.redis,
    env: deps.env ?? 'production',
    walletMetrics,
    rng: deps.rng,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
    logOutcome,
  });
  const sink = walletLoops.sink;
  // The reaper's failure re-drive needs its own Rng for backoff() jitter - distinct from deps.rng below.
  const reaperRng = deps.rng ?? { random: () => Math.random() };

  const reaperDeps: ReaperDeps = {
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    metrics,
    sink,
    graceSeconds: Math.floor(TIMING.reaperGraceMs / 1000),
    limit: SWEEP_MAX_ROWS,
    rng: reaperRng,
  };

  const reconcilerDeps: ReconcilerDeps = {
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    metrics,
    sink,
    reconcileWindowMs: TIMING.reconcileWindowMs,
    echoToleranceMs: TIMING.echoToleranceMs,
    maxRows: SWEEP_MAX_ROWS,
    now: () => Date.now(),
  };

  const reaperLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.reaper, () =>
        runOneReaperSweep(reaperDeps),
      ),
    intervalMs: TIMING.reaperIntervalMs,
    onOutcome: (outcome) => {
      logOutcome('reaper', outcome);
    },
    backoffScheduleMs: DB_ERROR_BACKOFF_MS,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  const reconcilerLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.reconciler, () =>
        runOneReconcilerSweep(reconcilerDeps),
      ),
    intervalMs: TIMING.reconcilerIntervalMs,
    jitterMs: Math.round(TIMING.reconcilerIntervalMs / 6),
    rng: deps.rng,
    onOutcome: (outcome) => {
      logOutcome('reconciler', outcome);
    },
    backoffScheduleMs: DB_ERROR_BACKOFF_MS,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  // The 5-minute per-instance warm-up ladder evaluator, same single-flight + cross-tenant-scan shape as the reaper/reconciler above.
  const pacingEvaluatorLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.pacingEvaluator, async () => {
        await runOnePacingEvaluatorSweep({
          pool: deps.pool,
          tenantDb: deps.tenantDb,
          clock: { now: () => Date.now() },
          publish: deps.pacingPublish ?? buildOutboxPacingPublish(deps.pool),
          env: deps.env ?? 'production',
          metrics: deps.warmupMetrics ?? bindPacingMetrics().warmupMetrics,
        });
      }),
    intervalMs: TIMING.pacingEvaluatorIntervalMs,
    onOutcome: (outcome) => {
      logOutcome('pacing-evaluator', outcome);
    },
    backoffScheduleMs: DB_ERROR_BACKOFF_MS,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  // Both `keyProvider` and `objectStore` must be supplied to arm the three contacts cron loops (fail-safe default: omitted = none).
  const contactsLoops =
    deps.keyProvider && deps.objectStore
      ? createContactsCronLoops({
          pool: deps.pool,
          tenantDb: deps.tenantDb,
          keyProvider: deps.keyProvider,
          objectStore: deps.objectStore,
          metrics: bindContactsMetrics(),
          rng: deps.rng,
          setIntervalFn: deps.setIntervalFn,
          clearIntervalFn: deps.clearIntervalFn,
          logOutcome,
        })
      : undefined;

  // One binding shared by broadcastLoops and epochLoops (bindBroadcastMetrics's own WeakMap keeps a rebind idempotent regardless).
  const broadcastMetrics = bindBroadcastMetrics();

  // The broadcast snapshot + expansion sweeps, always armed.
  const broadcastLoops = createBroadcastCronLoops({
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    rng: deps.rng,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
    logOutcome,
    metrics: broadcastMetrics,
  });

  // The deps quintet every always-armed sweep group takes identically.
  const sweepBase = {
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    rng: deps.rng,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
    logOutcome,
  };

  const mediaLoops = armMediaLoops({ ...sweepBase, objectStore: deps.objectStore });

  // Always armed: epoch reconciliation; fleet rollup + opt-out rate; admin-relax expiry.
  const epochLoops = createEpochCronLoops({ ...sweepBase, metrics: broadcastMetrics });
  const rollupLoops = createRollupCronLoops({
    ...sweepBase,
    metricRollupIntervalMs: deps.metricRollupIntervalMs,
  });
  const adminRelaxLoops = createAdminRelaxCronLoops(sweepBase);

  return {
    reaperLoop,
    reconcilerLoop,
    pacingEvaluatorLoop,
    chargerLoop: walletLoops.chargerLoop,
    walletRollupLoop: walletLoops.walletRollupLoop,
    walletReconcileLoop: walletLoops.walletReconcileLoop,
    contactsLoops,
    mediaLoops,
    broadcastLoops,
    epochLoops,
    rollupLoops,
    adminRelaxLoops,
    start(): void {
      reaperLoop.start();
      reconcilerLoop.start();
      pacingEvaluatorLoop.start();
      walletLoops.chargerLoop?.start();
      walletLoops.walletRollupLoop.start();
      walletLoops.walletReconcileLoop.start();
      contactsLoops?.importLoop.start();
      contactsLoops?.mirrorReconcileLoop.start();
      contactsLoops?.importPurgeLoop.start();
      mediaLoops?.mediaPurgeLoop.start();
      startBroadcastCronLoops(broadcastLoops);
      epochLoops.reconcileLoop.start();
      rollupLoops.metricRollupLoop.start();
      rollupLoops.optoutRateLoop.start();
      adminRelaxLoops.expiryLoop.start();
    },
    stop(): void {
      reaperLoop.stop();
      reconcilerLoop.stop();
      pacingEvaluatorLoop.stop();
      walletLoops.chargerLoop?.stop();
      walletLoops.walletRollupLoop.stop();
      walletLoops.walletReconcileLoop.stop();
      contactsLoops?.importLoop.stop();
      contactsLoops?.mirrorReconcileLoop.stop();
      contactsLoops?.importPurgeLoop.stop();
      mediaLoops?.mediaPurgeLoop.stop();
      stopBroadcastCronLoops(broadcastLoops);
      epochLoops.reconcileLoop.stop();
      rollupLoops.metricRollupLoop.stop();
      rollupLoops.optoutRateLoop.stop();
      adminRelaxLoops.expiryLoop.stop();
    },
  };
}
