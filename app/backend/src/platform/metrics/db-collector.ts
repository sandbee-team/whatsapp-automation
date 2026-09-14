import { loadNamedQuery, bindQueryParams } from '@wp/db';
import type { WpLogger } from '@wp/server-kit';
import { bindRollupMetrics, type RollupMetricsHandles } from './rollup-metrics.js';

/**
 * platform/metrics/db-collector.ts (P25 observability-and-runbook, Unit U3)
 * - `createDbMetricsCollector`, the ONE scheduled aggregate statement that
 * fills the five fleet-level rollup gauges (`rollup-metrics.ts`). ADR 0018
 * S4: no singleton loop may be O(active) faster than 5 minutes - enforced
 * HERE, at construction, not left to the caller's own cron cadence choice:
 * `RollupIntervalTooShortError` throws before any timer is armed.
 *
 * A failing collector must never affect sending: `runOnce` holds only a pool
 * and gauge handles, never touches the send path, logs `name`/`code` ONLY (a
 * pg message/detail can carry row values - e.g. a unique-constraint
 * violation's `detail` carries the conflicting row's own data), and leaves
 * the gauges at their PREVIOUS values on any failure - never a partial or
 * zeroed write. The backoff itself is the cron loop's own job
 * (`DB_ERROR_BACKOFF_MS` in `cron-wiring.ts`), same as every other loop in
 * this tree; this module only reports 'ran' | 'db_error'.
 */

export const MIN_ROLLUP_INTERVAL_MS = 300_000;

export class RollupIntervalTooShortError extends Error {
  constructor(intervalMs: number) {
    super(
      `RollupIntervalTooShortError: intervalMs (${String(intervalMs)}) is below the minimum ` +
        `${String(MIN_ROLLUP_INTERVAL_MS)} ms (ADR 0018 S4 - no singleton loop may be O(active) ` +
        `faster than 5 minutes)`,
    );
    this.name = 'RollupIntervalTooShortError';
  }
}

interface FleetRollupRow extends Record<string, unknown> {
  messages_out_without_job: number;
  jobs_blocked_needs_review: number;
  jobs_needs_reconcile: number;
  instances_connected: number;
  instances_desired_online: number;
}

export interface DbMetricsCollectorPool {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface DbMetricsCollectorDeps {
  pool: DbMetricsCollectorPool;
  /** Defaults to `MIN_ROLLUP_INTERVAL_MS` (300_000). Throws `RollupIntervalTooShortError` below the minimum. */
  intervalMs?: number;
  /** Defaults to the real `bindRollupMetrics()`; inject a fake registry's handles for tests. */
  metrics?: RollupMetricsHandles;
  logger?: Pick<WpLogger, 'error' | 'warn' | 'info'>;
}

export interface DbMetricsCollector {
  intervalMs: number;
  runOnce(): Promise<'ran' | 'db_error'>;
}

/** Renders a db_error tick-failure log line - name/code ONLY, never a pg message/detail (which can carry row values). */
function tickFailureMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const code = (error as { code?: unknown } | null)?.code;
  const suffix = code ? ` (${String(code)})` : '';
  return `metric rollup collector tick failed, backing off: ${name}${suffix}`;
}

export function createDbMetricsCollector(deps: DbMetricsCollectorDeps): DbMetricsCollector {
  const intervalMs = deps.intervalMs ?? MIN_ROLLUP_INTERVAL_MS;
  if (intervalMs < MIN_ROLLUP_INTERVAL_MS) {
    throw new RollupIntervalTooShortError(intervalMs);
  }

  const metrics = deps.metrics ?? bindRollupMetrics();

  return {
    intervalMs,
    async runOnce(): Promise<'ran' | 'db_error'> {
      try {
        const query = await loadNamedQuery('metric-rollups', 'metric-rollup-fleet');
        const result = await deps.pool.query<FleetRollupRow>(
          query.text,
          bindQueryParams(query, {}),
        );
        const row = result.rows[0];
        if (!row) {
          throw new Error('metric-rollup-fleet returned no row');
        }
        metrics.setFleetRollups({
          messagesOutWithoutJob: row.messages_out_without_job,
          jobsBlockedNeedsReview: row.jobs_blocked_needs_review,
          jobsNeedsReconcile: row.jobs_needs_reconcile,
          instancesConnected: row.instances_connected,
          instancesDesiredOnline: row.instances_desired_online,
        });
        return 'ran';
      } catch (err) {
        deps.logger?.error({}, tickFailureMessage(err));
        return 'db_error';
      }
    },
  };
}
