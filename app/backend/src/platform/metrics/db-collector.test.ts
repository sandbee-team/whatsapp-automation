import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import {
  createDbMetricsCollector,
  RollupIntervalTooShortError,
  MIN_ROLLUP_INTERVAL_MS,
  type DbMetricsCollectorPool,
} from './db-collector.js';
import { bindRollupMetrics } from './rollup-metrics.js';
import { createRollupCronLoops } from '../../engine/cron/cron-wiring-rollups.js';

/**
 * db-collector.test.ts (P25 observability-and-runbook, Unit U3) - proves
 * ADR 0018 S4's 5-minute floor is enforced at CONSTRUCTION (never left to
 * the caller's own cron cadence choice), that a successful tick sets every
 * gauge to an EXACT value with no client_id/instance_id label anywhere, and
 * that a DB failure is fail-safe: gauges keep their previous values, the log
 * line carries name/code ONLY (never a pg message/detail, which can carry
 * row values), and the collector recovers cleanly on its next tick.
 */

function makeFakePool(
  handler: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
): DbMetricsCollectorPool & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> {
      calls.push(text);
      const result = await handler(text, params);
      return result as { rows: T[] };
    },
  };
}

describe('rollup_collector_never_runs_faster_than_five_minutes', () => {
  it('rejects an interval below the five-minute floor', () => {
    const pool = makeFakePool(async () => ({ rows: [] }));
    expect(() => createDbMetricsCollector({ pool, intervalMs: 30_000 })).toThrow(
      RollupIntervalTooShortError,
    );
  });

  it('accepts the floor and above', () => {
    const pool = makeFakePool(async () => ({ rows: [] }));
    expect(() =>
      createDbMetricsCollector({ pool, intervalMs: MIN_ROLLUP_INTERVAL_MS }),
    ).not.toThrow();
    expect(() => createDbMetricsCollector({ pool, intervalMs: 900_000 })).not.toThrow();
  });

  it('createRollupCronLoops throws at construction for a sub-floor interval - nothing armed', () => {
    const pool = makeFakePool(async () => ({ rows: [] })) as never;
    const tenantDb = { withTenant: vi.fn() } as never;
    const setIntervalFn = vi.fn();
    expect(() =>
      createRollupCronLoops({
        pool,
        tenantDb,
        setIntervalFn,
        clearIntervalFn: vi.fn(),
        logOutcome: vi.fn(),
        metricRollupIntervalMs: 30_000,
      }),
    ).toThrow(RollupIntervalTooShortError);
    expect(setIntervalFn).not.toHaveBeenCalled();
  });
});

describe('collector_emits_no_client_or_instance_label', () => {
  it('sets every gauge to the exact row value with no tenant-scoped label', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindRollupMetrics(registry);
    const pool = makeFakePool(async () => ({
      rows: [
        {
          messages_out_without_job: 0,
          jobs_blocked_needs_review: 3,
          jobs_needs_reconcile: 1,
          instances_connected: 7,
          instances_desired_online: 9,
        },
      ],
    }));

    const collector = createDbMetricsCollector({ pool, metrics });
    const outcome = await collector.runOnce();
    expect(outcome).toBe('ran');

    const text = await registry.metricsText();
    expect(text).toContain('wp_instances_connected 7');
    expect(text).toContain('wp_jobs_blocked_needs_review 3');
    expect(text).toContain('wp_jobs_needs_reconcile 1');
    expect(text).toContain('wp_instances_desired_online 9');
    expect(text).toContain('wp_messages_out_without_job 0');
    expect(text).not.toContain('instance_id=');
    expect(text).not.toContain('client_id=');
  });
});

describe('collector_failure_does_not_stop_the_worker', () => {
  it('backs off fail-safe, logs name/code only, keeps prior gauges, and recovers next tick', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindRollupMetrics(registry);
    const dbError = Object.assign(new Error('duplicate key value violates unique constraint "x"'), {
      code: '23505',
      detail: 'Key (email)=(SENTINEL_ROW_VALUE) already exists.',
    });

    let shouldFail = true;
    const pool = makeFakePool(async () => {
      if (shouldFail) {
        throw dbError;
      }
      return {
        rows: [
          {
            messages_out_without_job: 0,
            jobs_blocked_needs_review: 5,
            jobs_needs_reconcile: 2,
            instances_connected: 4,
            instances_desired_online: 6,
          },
        ],
      };
    });

    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const collector = createDbMetricsCollector({ pool, metrics, logger });

    const firstOutcome = await collector.runOnce();
    expect(firstOutcome).toBe('db_error');
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [, message] = logger.error.mock.calls[0]!;
    expect(message).toContain('23505');
    expect(message).not.toContain('SENTINEL_ROW_VALUE');

    const text = await registry.metricsText();
    expect(text).not.toContain('wp_instances_connected 4');
    expect(text).toContain('wp_instances_connected 0');

    const withoutLeadingComments = (sql: string) =>
      sql.replace(/^(\s*--[^\n]*\n)+/, '').trimStart();
    expect(pool.calls.every((sql) => /^(?:WITH|SELECT)\b/i.test(withoutLeadingComments(sql)))).toBe(
      true,
    );

    shouldFail = false;
    const secondOutcome = await collector.runOnce();
    expect(secondOutcome).toBe('ran');
    const textAfter = await registry.metricsText();
    expect(textAfter).toContain('wp_instances_connected 4');
  });
});
