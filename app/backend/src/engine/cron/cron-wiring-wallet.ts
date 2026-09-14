import type { TenantDb } from '@wp/db';
import { TIMING } from '@wp/domain';
import {
  createChargerWorker,
  createWalletRepairedSendSink,
  runOneWalletReconcileSweep,
  runOneWalletRollupSweep,
  type ChargerRedis,
} from '../../modules/wallet/index.js';
import type { RepairedSendSink } from '../../modules/queue/repaired-send-sink.js';
import type { WalletMetricsHandles } from '../../platform/metrics/wallet-metrics.js';
import { CRON_LOCK_KEYS, runWithSingleFlightLock } from './single-flight.js';
import { createCronLoop, type CronLoop, type CronTickOutcome } from './cron-loop.js';
import { DB_ERROR_BACKOFF_MS, type CronWiringPool } from './cron-wiring.js';

/**
 * cron-wiring-wallet.ts (P18 Unit U5) - composes the three wallet-charging
 * cadences on top of `cron-loop.ts`/`single-flight.ts`, split out of
 * `cron-wiring.ts` purely for that file's own max-lines cap (same split
 * idiom as `session-worker-discovery-wiring.ts`).
 *
 * The real `RepairedSendSink` (`createWalletRepairedSendSink`) is built HERE
 * and returned as `sink` - `cron-wiring.ts` wires it into both the reaper and
 * reconciler deps, replacing the P12 no-op placeholder.
 *
 * `chargerLoop` (drains the per-tenant Redis charge queue) is deliberately
 * NOT single-flighted: `redis.spop`/`rpop` are atomic Redis commands, so two
 * replicas draining concurrently can never double-pop the same item, and
 * `chargeRepairedSend`'s own guard-first debit makes a duplicate charge
 * attempt a correct no-op either way (ADR 0019 S2). It only exists when
 * `deps.redis` is supplied - `roles/cron.ts` omits it entirely when
 * `REDIS_URL` is unset (fail-safe: the hourly reconciler check B remains the
 * backstop).
 *
 * `walletRollupLoop`/`walletReconcileLoop` DO run under
 * `runWithSingleFlightLock` (same cross-tenant-scan concurrency reasoning
 * `cron-wiring.ts`'s own header documents for the reaper/reconciler) - each
 * with its own `CRON_LOCK_KEYS` entry, `TIMING.wallet*` interval, and
 * `DB_ERROR_BACKOFF_MS` backoff schedule.
 */

export interface CreateWalletCronLoopsDeps {
  pool: CronWiringPool;
  tenantDb: TenantDb;
  /** Omitted -> no charger loop is built; the reconciler's check B remains the only charge path (fail-safe, never throws). */
  redis?: ChargerRedis;
  env: string;
  walletMetrics: WalletMetricsHandles;
  rng?: { random: () => number };
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  logOutcome: (loopName: string, outcome: CronTickOutcome, error?: unknown) => void;
}

export interface WalletCronLoops {
  sink: RepairedSendSink;
  chargerLoop?: CronLoop;
  walletRollupLoop: CronLoop;
  walletReconcileLoop: CronLoop;
}

export function createWalletCronLoops(deps: CreateWalletCronLoopsDeps): WalletCronLoops {
  const charger = deps.redis
    ? createChargerWorker({
        redis: deps.redis,
        env: deps.env,
        tenantDb: deps.tenantDb,
        metrics: deps.walletMetrics,
      })
    : undefined;

  const sink = createWalletRepairedSendSink({
    tenantDb: deps.tenantDb,
    enqueueCharge: charger ? (item) => charger.enqueue(item) : undefined,
    metrics: deps.walletMetrics,
  });

  const chargerLoop = charger
    ? createCronLoop({
        runOne: async () => {
          try {
            await charger.drainOnce();
            return { outcome: 'ran' };
          } catch (err) {
            return { outcome: 'db_error', error: err };
          }
        },
        intervalMs: TIMING.walletChargerDrainIntervalMs,
        onOutcome: (outcome) => {
          deps.logOutcome('wallet-charger', outcome);
        },
        backoffScheduleMs: DB_ERROR_BACKOFF_MS,
        setIntervalFn: deps.setIntervalFn,
        clearIntervalFn: deps.clearIntervalFn,
      })
    : undefined;

  const walletRollupLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.walletRollup, async () => {
        await runOneWalletRollupSweep({ pool: deps.pool, tenantDb: deps.tenantDb });
      }),
    intervalMs: TIMING.walletRollupIntervalMs,
    jitterMs: Math.round(TIMING.walletRollupIntervalMs / 12),
    rng: deps.rng,
    onOutcome: (outcome) => {
      deps.logOutcome('wallet-rollup', outcome);
    },
    backoffScheduleMs: DB_ERROR_BACKOFF_MS,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  const walletReconcileLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.walletReconcile, async () => {
        await runOneWalletReconcileSweep({
          pool: deps.pool,
          tenantDb: deps.tenantDb,
          metrics: deps.walletMetrics,
        });
      }),
    intervalMs: TIMING.walletReconcileIntervalMs,
    jitterMs: Math.round(TIMING.walletReconcileIntervalMs / 12),
    rng: deps.rng,
    onOutcome: (outcome) => {
      deps.logOutcome('wallet-reconcile', outcome);
    },
    backoffScheduleMs: DB_ERROR_BACKOFF_MS,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  return { sink, chargerLoop, walletRollupLoop, walletReconcileLoop };
}
