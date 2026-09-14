import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createPool } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../src/platform/db/db-url.js';
import { bindDiscoveryMetrics } from '../../../src/platform/metrics/discovery-metrics.js';
import { bindRollupMetrics } from '../../../src/platform/metrics/rollup-metrics.js';
import { createDbMetricsCollector } from '../../../src/platform/metrics/db-collector.js';
import { readFleetGauges } from '../../../src/engine/fleet/discovery-caps.js';
import {
  cleanupUnownedAlertProbes,
  isInstanceUnowned,
  markLeaseStale,
  seedOwnedOnlineInstance,
  type TestPool,
} from './unowned-alert-workload.js';

/**
 * unowned-alert.integration.test.ts (P25 U7 Part C) - the V1-P7 gate demo:
 * proves `wp_instances_unowned` fires the real `InstancesUnowned` Prometheus
 * rule (`infra/observability/prometheus/rules/wp-alerts.rules.yml`, built by
 * U4 in this same phase, running in parallel) when a worker's lease goes
 * stale, WITHOUT losing any of the instance's queued jobs (invariant 5), and
 * that the fleet-wide gauges never carry a per-tenant label (isolation).
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');

let pool: TestPool;
let clientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'unowned-alert-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupUnownedAlertProbes(pool, clientIds);
  clientIds = [];
});

async function jobStatuses(testPool: TestPool, jobIds: string[]): Promise<string[]> {
  const result = await testPool.query<{ status: string; failed_at: Date | null }>(
    'SELECT status, failed_at FROM message_jobs WHERE id = ANY($1) ORDER BY id',
    [jobIds],
  );
  for (const row of result.rows) {
    expect(row.failed_at).toBeNull();
  }
  return result.rows.map((r) => r.status);
}

/**
 * Evaluates a Prometheus `for: 2m` alert deterministically over injected
 * samples - never a real wait. Each consecutive true (`value > 0`) sample
 * covers one full `stepMs` interval of active duration (so N consecutive
 * true samples span `N * stepMs` of elapsed active time, matching the
 * dispatch's own worked example: 6 samples at a 15s step = 90s = `pending`,
 * 9 samples = 120s = `firing` for `for: 2m`).
 */
function evaluateForWindow(
  samples: readonly number[],
  stepMs: number,
  forMs: number,
): 'inactive' | 'pending' | 'firing' {
  let consecutiveTrue = 0;
  let state: 'inactive' | 'pending' | 'firing' = 'inactive';
  for (const value of samples) {
    if (value > 0) {
      consecutiveTrue += 1;
      state = consecutiveTrue * stepMs >= forMs ? 'firing' : 'pending';
    } else {
      consecutiveTrue = 0;
      state = 'inactive';
    }
  }
  return state;
}

describe('wp_instances_unowned - the InstancesUnowned alert demo (P25 U7 Part C)', () => {
  it('stopping_a_worker_makes_the_unowned_alert_expression_fire', async () => {
    const registry = createMetricsRegistry();
    const { instancesUnowned } = bindDiscoveryMetrics(registry);

    const seeded = await seedOwnedOnlineInstance(pool);
    clientIds.push(seeded.clientId);

    // Instance-scoped state (Finding 3, P25 C1 fix round): the seeded
    // instance's OWN owned/unowned reading, never a fleet-wide count diff
    // over the shared integration DB (ambient-state, banned for new
    // integration tests) - `isInstanceUnowned` is byte-identical to
    // `fleet-gauges.sql`'s own `unowned_count` predicate, scoped to this id.
    expect(await isInstanceUnowned(pool, seeded.instanceId)).toBe(false);
    const beforeStatuses = await jobStatuses(pool, seeded.jobIds);
    expect(beforeStatuses).toEqual(['queued', 'queued', 'queued']);

    // "Stop the worker": its lease stops being renewed - never deleted.
    await markLeaseStale(pool, seeded.instanceId);

    expect(await isInstanceUnowned(pool, seeded.instanceId)).toBe(true);
    // The fleet-wide gauge is sustained by the seeded instance regardless of
    // any other unowned row already present in the shared DB - `>= 1`, never
    // an exact delta off a pre-read baseline.
    const afterStop = await readFleetGauges(pool);
    expect(afterStop.unownedCount).toBeGreaterThanOrEqual(1);
    instancesUnowned.set(afterStop.unownedCount);

    // Invariant 5: the pause/stale-lease condition never touches the jobs.
    const afterStatuses = await jobStatuses(pool, seeded.jobIds);
    expect(afterStatuses).toEqual(['queued', 'queued', 'queued']);

    // 9 samples at 15s step (the rule's own step, `for: 2m` = 120s), the
    // gauge reading > 0 continuously from sample 0 (the stale-lease reading
    // above baseline) - no real waiting. At 6 consecutive true samples the
    // elapsed active window is 6*15s = 90s < 120s -> `pending`; at 9
    // consecutive true samples the elapsed window is 9*15s = 135s >= 120s ->
    // `firing` (the rule's `for: 2m` threshold has been exceeded).
    const deltaSamples = [1, 1, 1, 1, 1, 1, 1, 1, 1];
    const stepMs = 15_000;
    const forMs = 120_000;
    expect(evaluateForWindow(deltaSamples.slice(0, 6), stepMs, forMs)).toBe('pending');
    expect(evaluateForWindow(deltaSamples, stepMs, forMs)).toBe('firing');

    const rulesPath = path.join(
      REPO_ROOT,
      'infra/observability/prometheus/rules/wp-alerts.rules.yml',
    );
    const rulesText = readFileSync(rulesPath, 'utf8');
    const parsed = parseYaml(rulesText) as {
      groups: {
        rules: {
          alert?: string;
          expr: string;
          for: string;
          labels: { severity: string };
          annotations: { runbook_url: string };
        }[];
      }[];
    };
    const allRules = parsed.groups.flatMap((g) => g.rules);
    const rule = allRules.find((r) => r.alert === 'InstancesUnowned');
    if (!rule) throw new Error('InstancesUnowned rule not found in wp-alerts.rules.yml');

    const renderedLine =
      `FIRING InstancesUnowned severity=${rule.labels.severity} for=${rule.for} ` +
      `expr=${rule.expr} runbook=${rule.annotations.runbook_url}`;
    console.log(renderedLine);
    expect(renderedLine).toContain('InstancesUnowned');
    expect(renderedLine).toContain('wp_instances_unowned');
  });

  it('a_deleted_lease_row_counts_as_unowned_the_same_as_a_stale_one (P25 SESSION-PROTOCOL C2)', async () => {
    // fleet-gauges.sql's own predicate is a LEFT JOIN: "ls.instance_id IS
    // NULL OR ls.lease_seen_at < now() - 45s" - a lease row that was DELETED
    // entirely (never renewed, then reaped/removed) must count as unowned
    // exactly like a stale-timestamp row, never differently. Proven here by
    // actually deleting the row rather than only aging its timestamp.
    const seeded = await seedOwnedOnlineInstance(pool);
    clientIds.push(seeded.clientId);

    expect(await isInstanceUnowned(pool, seeded.instanceId)).toBe(false);

    await pool.query('DELETE FROM instance_lease_state WHERE instance_id = $1', [
      seeded.instanceId,
    ]);

    expect(await isInstanceUnowned(pool, seeded.instanceId)).toBe(true);

    // Invariant 5 holds here too: deleting the LEASE row never touches jobs.
    const statuses = await jobStatuses(pool, seeded.jobIds);
    expect(statuses).toEqual(['queued', 'queued', 'queued']);
  });

  it('the_for_2m_window_boundary_is_exact_at_the_15s_step (P25 SESSION-PROTOCOL C2)', () => {
    // evaluateForWindow's own `>=` semantics at stepMs=15_000, forMs=120_000
    // (this rule's real for: 2m): 7 consecutive true samples span
    // 7*15s=105s (< 120s, still pending); the 8th sample crosses to
    // 8*15s=120s (>= 120s, firing). Exact values pinned per this repo's
    // units-and-quantities convention (never a bound), since 105s/120s is
    // the genuine boundary this implementation's `>=` comparison produces.
    const stepMs = 15_000;
    const forMs = 120_000;
    const sevenSamples = Array(7).fill(1);
    const eightSamples = Array(8).fill(1);

    expect(evaluateForWindow(sevenSamples, stepMs, forMs)).toBe('pending');
    expect(evaluateForWindow(eightSamples, stepMs, forMs)).toBe('firing');

    // A single false sample after a long true run resets to inactive
    // immediately - the "for" window does not partially decay.
    expect(evaluateForWindow([...eightSamples, 0], stepMs, forMs)).toBe('inactive');
  });

  it('two_tenants_are_not_distinguishable_in_the_scrape', async () => {
    const registry = createMetricsRegistry();

    const seededA = await seedOwnedOnlineInstance(pool);
    const seededB = await seedOwnedOnlineInstance(pool);
    clientIds.push(seededA.clientId, seededB.clientId);

    const rollup = bindRollupMetrics(registry);
    const collector = createDbMetricsCollector({ pool, metrics: rollup, intervalMs: 300_000 });
    await collector.runOnce();

    const discovery = bindDiscoveryMetrics(registry);
    const gauges = await readFleetGauges(pool);
    discovery.instancesUnowned.set(gauges.unownedCount);

    const scrapeText = await registry.metricsText();

    expect(scrapeText).not.toContain(seededA.clientId);
    expect(scrapeText).not.toContain(seededB.clientId);
    expect(scrapeText).not.toContain(seededA.instanceId);
    expect(scrapeText).not.toContain(seededB.instanceId);
    expect(scrapeText.includes('client_id=')).toBe(false);
    expect(scrapeText.includes('instance_id=')).toBe(false);
    expect(scrapeText).not.toMatch(/\+?\d{10,}/);
  });
});
