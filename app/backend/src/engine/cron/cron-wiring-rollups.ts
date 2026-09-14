import type { TenantDb } from '@wp/db';
// Direct file import (not the `modules/inbound/index.js` barrel):
// `modules/inbound/index.ts` re-exports `message-signals.ts`, which reaches
// `modules/groups/index.js` -> `sync-worker.ts`, which reaches
// `provider/baileys/**`/`engine/session/**` - importing the FULL inbound
// barrel here would drag that whole transitive graph into `roles/cron.ts`
// and trip `cron-loop-shape.test.ts`'s structural ban (the cron role owns no
// socket/lease connection). `optout-rate-check.ts` itself has none of those
// dependencies, so importing it directly (same "engine/cron reaches a
// module's own file directly" precedent as this file's sibling
// `cron-wiring.ts`'s `modules/queue/reaper.js` import) keeps the ban intact.
import { runOptoutRateCheck } from '../../modules/inbound/optout-rate-check.js';
import {
  createDbMetricsCollector,
  type DbMetricsCollectorPool,
  type DbMetricsCollectorDeps,
} from '../../platform/metrics/db-collector.js';
import { CRON_LOCK_KEYS, runWithSingleFlightLock } from './single-flight.js';
import { createCronLoop, type CronLoop, type CronTickOutcome } from './cron-loop.js';
import type { CronWiringPool } from './cron-wiring-pacing-publish.js';

/**
 * cron-wiring-rollups.ts (P25 observability-and-runbook, Unit U3) - the two
 * always-armed rollup loops `cron-wiring.ts` composes alongside every other
 * `ROLE=cron` cadence: the 5-minute fleet-wide metric rollup collector
 * (`db-collector.ts`) and the hourly per-client opt-out-rate check
 * (`modules/inbound/optout-rate-check.ts`). Same
 * `runWithSingleFlightLock(pool, LOCK_KEY, fn)` shape as every sibling loop
 * in this tree - the lock guards CONCURRENCY ONLY (see `single-flight.ts`'s
 * own header); the collector/check run against `deps.pool`/`deps.tenantDb`,
 * never the lock's own `tx`.
 *
 * The collector's own constructor enforces the >= 300_000 ms floor (ADR 0018
 * S4) BEFORE any timer is armed - a caller passing `metricRollupIntervalMs:
 * 30_000` throws at `createRollupCronLoops` construction time, never at the
 * first tick.
 */

const OPTOUT_RATE_CHECK_INTERVAL_MS = 3_600_000;

export interface CreateRollupCronLoopsDeps {
  pool: CronWiringPool;
  tenantDb: TenantDb;
  rng?: { random: () => number };
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  logOutcome: (loopName: string, outcome: CronTickOutcome, error?: unknown) => void;
  /** Defaults to `MIN_ROLLUP_INTERVAL_MS` (300_000); the collector throws below that floor. */
  metricRollupIntervalMs?: number;
  metricsDeps?: Pick<DbMetricsCollectorDeps, 'metrics' | 'logger'>;
}

export interface RollupCronLoops {
  metricRollupLoop: CronLoop;
  optoutRateLoop: CronLoop;
}

export function createRollupCronLoops(deps: CreateRollupCronLoopsDeps): RollupCronLoops {
  const collector = createDbMetricsCollector({
    pool: deps.pool as DbMetricsCollectorPool,
    intervalMs: deps.metricRollupIntervalMs,
    metrics: deps.metricsDeps?.metrics,
    logger: deps.metricsDeps?.logger,
  });

  const metricRollupLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.metricRollup, async () => {
        await collector.runOnce();
      }),
    intervalMs: collector.intervalMs,
    rng: deps.rng,
    onOutcome: (outcome, error) => {
      deps.logOutcome('metric-rollup', outcome, error);
    },
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  const optoutRateLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.optoutRateCheck, async () => {
        await runOptoutRateCheck({ pool: deps.pool, tenantDb: deps.tenantDb, nowMs: Date.now() });
      }),
    intervalMs: OPTOUT_RATE_CHECK_INTERVAL_MS,
    rng: deps.rng,
    onOutcome: (outcome, error) => {
      deps.logOutcome('optout-rate-check', outcome, error);
    },
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  return { metricRollupLoop, optoutRateLoop };
}
