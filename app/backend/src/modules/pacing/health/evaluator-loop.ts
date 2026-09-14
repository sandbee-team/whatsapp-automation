import { loadQuery, bindQueryParams, type TenantDb } from '@wp/db';
import { logger } from '@wp/server-kit';
import { evaluate, type HealthEvaluatorClock } from './HealthEvaluator.js';
import { setHealthScoreGauge } from './metrics.js';

/**
 * evaluator-loop.ts (P16 Unit E, step 9) - the health evaluator's own
 * dirty-set/due-scan sweep, mirroring `engine/pacing/warmup-evaluator.ts`'s
 * established due-scan + per-tenant-evaluation shape exactly: one bounded
 * (`LIMIT`-ed, `db/queries/health-due.sql`) cross-tenant scan per tick, then
 * every due row's actual evaluation runs inside `tenantDb.withTenant
 * (clientId, ...)` under the real `app.client_id` GUC - never the scan
 * connection again (ADR 0018 §4 / scope-delta row 4-5: no singleton loop may
 * be O(active instances) faster than 5 minutes; this loop is O(due),
 * regardless of fleet size).
 *
 * MAJOR-3-CLASS FAIL-SAFE (same as `runOnePacingEvaluatorSweep`): one row's
 * evaluation failure is caught, logged (ids only) and counted - it never
 * aborts the rest of the tick's batch. CORRECTED crash semantics (P16 fix
 * round, Fix 3): `health-due.sql`'s scan itself CLAIMS every row it returns,
 * atomically pushing `eval_due_at` 60 seconds into the future as part of the
 * same statement (that file's own header) - a row's `eval_due_at` is never
 * "unchanged" after this tick, claimed or not. A crashed evaluation therefore
 * becomes due again once that 60s claim window elapses (60s = tier 1's own
 * cadence, `eval-tier-ladder.ts`) - never permanently stuck, never silently
 * dropped, never treated as "healthy" by omission, and never delayed past
 * its next natural due time.
 */

const DEFAULT_MAX_ROWS = 200;

export interface HealthDueRow extends Record<string, unknown> {
  instance_id: string;
  client_id: string;
}

export interface HealthEvaluatorLoopPool {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface RunOneHealthEvaluatorSweepDeps {
  pool: HealthEvaluatorLoopPool;
  tenantDb: TenantDb;
  clock: HealthEvaluatorClock;
  /** Bounded batch size - defaults to `DEFAULT_MAX_ROWS` (200, the task's own literal), never unbounded. */
  limit?: number;
}

export interface HealthEvaluatorSweepOutcome {
  scanned: number;
  errors: number;
}

/** Runs the registered `health-due.sql` delegate - the ONE cross-tenant read this loop ever issues on the bare pool connection. */
export async function scanForHealthDue(
  pool: HealthEvaluatorLoopPool,
  maxRows: number,
): Promise<HealthDueRow[]> {
  const query = await loadQuery('health-due');
  const params = bindQueryParams(query, { max_rows: maxRows });
  const result = await pool.query<HealthDueRow>(query.text, params);
  return result.rows;
}

/**
 * Runs one health-evaluator sweep: scans due instances (bounded, via
 * `health-due.sql`), and evaluates each one under its own tenant transaction.
 * Never called from the send path - a dedicated timer (`roles/session-
 * worker.ts` via its own wiring module) is the only production caller.
 */
export async function runOneHealthEvaluatorSweep(
  deps: RunOneHealthEvaluatorSweepDeps,
): Promise<HealthEvaluatorSweepOutcome> {
  const limit = deps.limit ?? DEFAULT_MAX_ROWS;
  const dueRows = await scanForHealthDue(deps.pool, limit);

  let errors = 0;
  const scoresThisPass: number[] = [];
  for (const row of dueRows) {
    try {
      const result = await deps.tenantDb.withTenant(row.client_id, (tx) =>
        evaluate({ sql: tx, clientId: row.client_id, clock: deps.clock }, row.instance_id),
      );
      scoresThisPass.push(result.score);
    } catch (err) {
      errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { instance_id: row.instance_id, client_id: row.client_id },
        `health evaluator: instance evaluation failed, continuing sweep: ${message}`,
      );
    }
  }

  // Fleet-wide worst-instance signal (metrics.ts's own doc) - a no-op when
  // this pass evaluated zero instances (never a fabricated 0/100).
  setHealthScoreGauge(scoresThisPass);

  return { scanned: dueRows.length, errors };
}
