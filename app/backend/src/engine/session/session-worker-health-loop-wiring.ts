import type { createPool, TenantDb } from '@wp/db';
import { logger, describeError } from '@wp/server-kit';
import { runOneHealthEvaluatorSweep } from '../../modules/pacing/health/evaluator-loop.js';
import { runHealthSamplesCleanup } from '../../modules/pacing/health/retention.js';

/**
 * session-worker-health-loop-wiring.ts (P16 Unit E, step 9; retention sweep
 * added in the P16 gate-fix pass) - the thin `roles/session-worker.ts` call
 * site for the health evaluator's dirty-set due-scan sweep AND the
 * `instance_health_samples` retention sweep, mechanically split out (mirrors
 * `session-cost-feedback-timer.ts`'s own split rationale) so `roles/**` stays
 * thin and the role file does not breach the max-lines cap. All the actual
 * scan/evaluate logic lives in `modules/pacing/health/evaluator-loop.ts` -
 * this module only supplies the interval-with-jitter timers, matching
 * `roles/session-worker.ts`'s own discovery-scan timer cadence idiom (base +
 * random jitter, fire-and-reschedule-on-completion rather than a fixed
 * `setInterval`, so a slow tick never overlaps the next one).
 *
 * RETENTION SWEEP ROLE FIX: `runHealthSamplesCleanup` was originally wired
 * into `roles/relay.ts`'s `wp_relay` cleanup transaction, which required
 * granting `wp_relay` SELECT/DELETE on `instance_health_samples` - that
 * violated the deliberate containment invariant asserted by
 * `db/tests/wp-relay-role.test.ts`'s `wp_relay_has_no_grant_on_any_table_
 * beyond_the_four_it_owns` (P15 grant narrowing). The sweep instead runs
 * HERE, in the session-worker process, under the SAME `wp_scheduler` login
 * role every other health write path already uses (migration 0046 grants
 * `wp_scheduler` DELETE on `instance_health_samples`; SELECT/INSERT already
 * held from migration 0044) - on its OWN low cadence (hourly ± jitter),
 * never the 5s due-scan tick.
 */

const SWEEP_INTERVAL_BASE_MS = 5_000;
const SWEEP_INTERVAL_JITTER_MS = 2_000;
const RETENTION_INTERVAL_BASE_MS = 60 * 60 * 1000;
const RETENTION_INTERVAL_JITTER_MS = 5 * 60 * 1000;

function sweepIntervalMs(): number {
  const jitter = (Math.random() * 2 - 1) * SWEEP_INTERVAL_JITTER_MS;
  return SWEEP_INTERVAL_BASE_MS + jitter;
}

function retentionIntervalMs(): number {
  const jitter = (Math.random() * 2 - 1) * RETENTION_INTERVAL_JITTER_MS;
  return RETENTION_INTERVAL_BASE_MS + jitter;
}

export interface HealthEvaluatorLoopDeps {
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  clock?: { now(): number };
}

export interface HealthEvaluatorLoopHandle {
  stop(): void;
}

/** Starts the health evaluator's due-scan timer AND the retention sweep timer immediately - returns a handle whose `stop()` clears both pending timeouts without waiting for an in-flight sweep. */
export function bootHealthEvaluatorLoop(deps: HealthEvaluatorLoopDeps): HealthEvaluatorLoopHandle {
  const clock = deps.clock ?? { now: () => Date.now() };
  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  let retentionHandle: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function scheduleNext(): void {
    if (stopped) return;
    timerHandle = setTimeout(() => {
      void runOneHealthEvaluatorSweep({ pool: deps.pool, tenantDb: deps.tenantDb, clock })
        .catch((err: unknown) => {
          logger.error({}, `health evaluator sweep failed: ${describeError(err)}`);
        })
        .finally(scheduleNext);
    }, sweepIntervalMs());
  }
  scheduleNext();

  function scheduleNextRetention(): void {
    if (stopped) return;
    retentionHandle = setTimeout(() => {
      void runHealthSamplesCleanup({ pool: deps.pool })
        .catch((err: unknown) => {
          logger.error({}, `health samples retention sweep failed: ${describeError(err)}`);
        })
        .finally(scheduleNextRetention);
    }, retentionIntervalMs());
  }
  scheduleNextRetention();

  return {
    stop: () => {
      stopped = true;
      if (timerHandle !== undefined) {
        clearTimeout(timerHandle);
      }
      if (retentionHandle !== undefined) {
        clearTimeout(retentionHandle);
      }
    },
  };
}
