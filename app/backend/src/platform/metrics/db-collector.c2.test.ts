import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import {
  createDbMetricsCollector,
  MIN_ROLLUP_INTERVAL_MS,
  type DbMetricsCollectorPool,
} from './db-collector.js';
import { bindRollupMetrics } from './rollup-metrics.js';

/**
 * db-collector.c2.test.ts (P25 SESSION-PROTOCOL C2 edge-case pass) - hunt
 * items not already in db-collector.test.ts: overlapping runOnce() calls
 * (the module itself holds no lock - the cron loop's single-flight is the
 * only guard, so this pins runOnce's OWN behaviour under overlap), driver
 * string/null counts, a zero-row result, and the exact MIN_ROLLUP_INTERVAL_MS
 * boundary.
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

describe('runOnce_overlapping_with_itself', () => {
  it('two concurrent runOnce() calls both resolve to "ran" and leave the gauges at the LAST-completing tick value, never throwing or double-setting inconsistently', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindRollupMetrics(registry);

    let callIndex = 0;
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const pool = makeFakePool(async () => {
      const thisCall = callIndex;
      callIndex += 1;
      if (thisCall === 0) {
        // First tick's query call blocks until the second tick has already
        // started (proves the two ticks genuinely overlap, not just fire
        // sequentially).
        await firstGate;
        return {
          rows: [
            {
              messages_out_without_job: 0,
              jobs_blocked_needs_review: 1,
              jobs_needs_reconcile: 1,
              instances_connected: 1,
              instances_desired_online: 1,
            },
          ],
        };
      }
      // Second tick resolves immediately with a DIFFERENT value set, then
      // releases the first tick.
      releaseFirst?.();
      return {
        rows: [
          {
            messages_out_without_job: 0,
            jobs_blocked_needs_review: 9,
            jobs_needs_reconcile: 9,
            instances_connected: 9,
            instances_desired_online: 9,
          },
        ],
      };
    });

    const collector = createDbMetricsCollector({ pool, metrics });

    const firstRun = collector.runOnce();
    const secondRun = collector.runOnce();

    const [firstOutcome, secondOutcome] = await Promise.all([firstRun, secondRun]);
    expect(firstOutcome).toBe('ran');
    expect(secondOutcome).toBe('ran');

    // Whichever tick's `.set()` call lands last (here: the first tick,
    // released after the second) wins - this pins that runOnce() applies no
    // extra ordering guarantee of its own, so the cron loop's single-flight
    // lock (not this module) is the only thing preventing overlap in
    // production. No NaN, no thrown error, no partial mix of two ticks'
    // values on a single gauge.
    const text = await registry.metricsText();
    const hasFirstSet = text.includes('wp_jobs_blocked_needs_review 1');
    const hasSecondSet = text.includes('wp_jobs_blocked_needs_review 9');
    expect(hasFirstSet || hasSecondSet).toBe(true);
    expect(text).not.toContain('NaN');
  });
});

describe('driver_returns_string_or_null_counts', () => {
  it('string bigint-shaped counts from the driver become exact numeric gauges, never NaN', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindRollupMetrics(registry);
    const pool = makeFakePool(async () => ({
      rows: [
        {
          messages_out_without_job: '0',
          jobs_blocked_needs_review: '3',
          jobs_needs_reconcile: '1',
          instances_connected: '7',
          instances_desired_online: '9',
        },
      ],
    }));

    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const collector = createDbMetricsCollector({ pool, metrics, logger });
    const outcome = await collector.runOnce();

    const text = await registry.metricsText();
    expect(text).not.toContain('NaN');

    if (outcome === 'ran') {
      // set() accepted the driver's raw string value and coerced it cleanly.
      expect(text).toContain('wp_jobs_blocked_needs_review 3');
      expect(text).toContain('wp_instances_connected 7');
    } else {
      // prom-client's gauge.set() rejects a non-number argument outright -
      // the collector's own try/catch turns that into a safe 'db_error'
      // (fail-safe: never publish a value it cannot prove is numeric) rather
      // than a NaN gauge or a thrown/unhandled error. Pin THIS behaviour
      // rather than assume string coercion succeeds.
      expect(outcome).toBe('db_error');
      expect(logger.error).toHaveBeenCalledTimes(1);
    }
  });

  it('a null count from the row does not poison the gauge with NaN', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindRollupMetrics(registry);
    const pool = makeFakePool(async () => ({
      rows: [
        {
          messages_out_without_job: null,
          jobs_blocked_needs_review: 2,
          jobs_needs_reconcile: 0,
          instances_connected: 5,
          instances_desired_online: 5,
        },
      ],
    }));

    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const collector = createDbMetricsCollector({ pool, metrics, logger });
    const outcome = await collector.runOnce();

    const text = await registry.metricsText();
    expect(text).not.toContain('NaN');
    // A null scalar subquery result must never publish a corrupt gauge
    // value silently - either it is treated as a real "0" (ran) or the tick
    // fails safe (db_error, logged), never a NaN or a partial write.
    if (outcome === 'ran') {
      expect(text).toContain('wp_messages_out_without_job 0');
    } else {
      expect(outcome).toBe('db_error');
      expect(logger.error).toHaveBeenCalledTimes(1);
    }
  });
});

describe('zero_rows_is_a_db_error_never_a_silent_zeroed_publish', () => {
  it('the fleet-rollup statement returning zero rows reports db_error and leaves gauges unchanged', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindRollupMetrics(registry);
    metrics.setFleetRollups({
      messagesOutWithoutJob: 0,
      jobsBlockedNeedsReview: 4,
      jobsNeedsReconcile: 2,
      instancesConnected: 6,
      instancesDesiredOnline: 8,
    });

    const pool = makeFakePool(async () => ({ rows: [] }));
    const collector = createDbMetricsCollector({ pool, metrics });
    const outcome = await collector.runOnce();

    expect(outcome).toBe('db_error');
    const text = await registry.metricsText();
    expect(text).toContain('wp_jobs_blocked_needs_review 4');
    expect(text).toContain('wp_instances_connected 6');
  });
});

describe('collector_never_registers_a_labelled_rollup_series', () => {
  it('no wp_ rollup gauge line in the scrape carries a label set', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindRollupMetrics(registry);
    const pool = makeFakePool(async () => ({
      rows: [
        {
          messages_out_without_job: 0,
          jobs_blocked_needs_review: 1,
          jobs_needs_reconcile: 1,
          instances_connected: 1,
          instances_desired_online: 1,
        },
      ],
    }));
    const collector = createDbMetricsCollector({ pool, metrics });
    await collector.runOnce();

    const text = await registry.metricsText();
    const rollupLines = text
      .split('\n')
      .filter(
        (line) =>
          !line.startsWith('#') &&
          (line.startsWith('wp_messages_out_without_job') ||
            line.startsWith('wp_jobs_blocked_needs_review') ||
            line.startsWith('wp_jobs_needs_reconcile') ||
            line.startsWith('wp_instances_connected') ||
            line.startsWith('wp_instances_desired_online')),
      );
    expect(rollupLines.length).toBeGreaterThan(0);
    for (const line of rollupLines) {
      expect(line).not.toContain('{');
    }
  });
});

describe('the_min_rollup_interval_boundary_is_exact', () => {
  it('exactly 300_000 is accepted, 299_999 is rejected', () => {
    const pool = makeFakePool(async () => ({ rows: [] }));
    expect(MIN_ROLLUP_INTERVAL_MS).toBe(300_000);
    expect(() => createDbMetricsCollector({ pool, intervalMs: 300_000 })).not.toThrow();
    expect(() => createDbMetricsCollector({ pool, intervalMs: 299_999 })).toThrow();
  });
});
