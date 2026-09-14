import type { TenantDb } from '@wp/db';
import { bindQueryParams, loadQuery } from '@wp/db';
import {
  bindBroadcastMetrics,
  type BroadcastMetricsHandles,
} from '../../platform/metrics/broadcast-metrics.js';
import { countStrandedEpochJobs, runEpochStrandingSweep } from '../../modules/broadcasts/index.js';
import { CRON_LOCK_KEYS, runWithSingleFlightLock } from './single-flight.js';
import { createCronLoop, type CronLoop, type CronTickOutcome } from './cron-loop.js';
import type { CronWiringPool } from './cron-wiring.js';

/**
 * cron-wiring-epoch.ts (P23 Unit U6, step 7) - the periodic epoch-
 * stranding RECONCILIATION sweep: belt-and-braces for a hook missed by a
 * crash (the primary detector is `store-purge.ts#runPurge`'s post-commit
 * `onEpochAdvanced` hook - see that module's own header). Fleet-wide,
 * bounded: discovers every LIVE instance (`epoch-sweep-instances-pending.
 * sql`, keyset-paginated), and re-scopes per instance via
 * `runEpochStrandingSweep` (tenantDb, RLS-scoped) - an instance with
 * nothing stranded simply moves 0 rows on its own call, so this scan never
 * needs to join `message_jobs` cross-tenant.
 *
 * After the sweep, recomputes the fleet-wide `wp_stranded_epoch_jobs` gauge
 * to an EXACT count (never incremented in place) - same idiom as every
 * other cron-driven gauge recount in this tree.
 *
 * Cadence: 5 minutes (ADR 0018 S4 - "no singleton loop may be O(active)
 * faster than 5 minutes"); this sweep's own frequency never scales with
 * fleet size (one bounded LIMIT-ed scan per tick, never per-instance).
 */

const EPOCH_SWEEP_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_INSTANCES_PER_SWEEP = 500;

interface PendingInstanceRow extends Record<string, unknown> {
  id: string;
  client_id: string;
  session_epoch: number;
}

export interface CreateEpochCronLoopDeps {
  pool: CronWiringPool;
  tenantDb: TenantDb;
  rng?: { random: () => number };
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  logOutcome: (loopName: string, outcome: CronTickOutcome, error?: unknown) => void;
  metrics?: BroadcastMetricsHandles;
  maxInstancesPerSweep?: number;
}

export interface EpochCronLoops {
  reconcileLoop: CronLoop;
}

/** Runs one fleet-wide reconciliation pass: sweeps every live instance, then recomputes the gauge. */
export async function runOneEpochReconciliationSweep(
  deps: Pick<CreateEpochCronLoopDeps, 'pool' | 'tenantDb' | 'maxInstancesPerSweep'> & {
    metrics: BroadcastMetricsHandles;
  },
): Promise<void> {
  const query = await loadQuery('epoch-sweep-instances-pending');
  const limit = deps.maxInstancesPerSweep ?? DEFAULT_MAX_INSTANCES_PER_SWEEP;
  const pending = await deps.pool.query<PendingInstanceRow>(
    query.text,
    bindQueryParams(query, { after_id: '00000000-0000-0000-0000-000000000000', limit }),
  );

  for (const row of pending.rows) {
    try {
      await runEpochStrandingSweep(
        { tenantDb: deps.tenantDb },
        { clientId: row.client_id, instanceId: row.id, currentEpoch: row.session_epoch },
      );
    } catch {
      // A single instance's sweep failure never aborts the rest of this
      // sweep's fleet - same shape as every other per-tenant cross-tenant
      // discovery loop's try/catch in this tree.
    }
  }

  const gaugeCount = await countStrandedEpochJobs(deps.pool);
  deps.metrics.setStrandedEpochJobs(gaugeCount);
}

/** Builds the single-flighted, 5-minute epoch reconciliation loop. */
export function createEpochCronLoops(deps: CreateEpochCronLoopDeps): EpochCronLoops {
  const metrics = deps.metrics ?? bindBroadcastMetrics();

  const reconcileLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.epochReconcile, async () => {
        await runOneEpochReconciliationSweep({
          pool: deps.pool,
          tenantDb: deps.tenantDb,
          maxInstancesPerSweep: deps.maxInstancesPerSweep,
          metrics,
        });
      }),
    intervalMs: EPOCH_SWEEP_INTERVAL_MS,
    rng: deps.rng,
    onOutcome: (outcome, error) => {
      deps.logOutcome('epoch-reconcile', outcome, error);
    },
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  return { reconcileLoop };
}
