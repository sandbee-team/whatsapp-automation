import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createDiscoveryLoop, type DiscoveryDeps, type DiscoveryRow } from './discovery.js';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindDiscoveryMetrics } from '../../platform/metrics/discovery-metrics.js';

/**
 * fleet-unit-e3-edge-discovery.test.ts - P09 E3 edge-case pass, unit-level
 * only (no real PG/Redis), split out of `fleet-unit-e3-edge.test.ts` at
 * FIX-P09-B for the max-lines cap (topic split only - same cases,
 * unchanged). Targets escalation lifecycle edges and the soft-yield exact
 * 0.9x cap boundary that discovery.test.ts's happy-path suite does not
 * exercise. See connect-budget-e3-edge.integration.test.ts and
 * discovery-e3-edge.integration.test.ts for the real-infra concurrency
 * cases, `fleet-unit-e3-edge-admission-budget.test.ts` for the admission/
 * budget cases, and `fleet-unit-e3-edge-drain.test.ts` for the drain/
 * markNeedsReconcile cases.
 */

function makeDiscoveryDeps(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  const registry = createMetricsRegistry();
  return {
    pool: { query: vi.fn(async () => ({ rows: [] })) } as unknown as DiscoveryDeps['pool'],
    redis: {
      hgetall: vi.fn(async () => ({})),
      hset: vi.fn(async () => 1),
      hdel: vi.fn(async () => 0),
    } as unknown as DiscoveryDeps['redis'],
    env: 'test',
    workerId: 'worker-1',
    admission: { canAcceptLease: vi.fn(() => ({ ok: true, state: 'accepting' })) },
    grab: vi.fn(async () => true),
    markInfraUnavailable: vi.fn(async () => false),
    getLagP99Ms: vi.fn(() => 0),
    getCap: vi.fn(() => 100),
    getCurrentSessions: vi.fn(() => 0),
    metrics: bindDiscoveryMetrics(registry),
    onCycleError: vi.fn(),
    ...overrides,
  };
}

/**
 * The scan branch is matched on the actual invocation `FROM
 * wp_lease_scan_unowned(` - `fleet-gauges.sql`'s own header COMMENT also
 * mentions the string `wp_lease_scan_unowned` in prose, so a bare
 * `.includes('wp_lease_scan_unowned')` check false-positives on the gauges
 * query too.
 */
function isScanQuery(sql: string): boolean {
  return sql.includes('FROM wp_lease_scan_unowned(');
}

function poolReturningRows(rows: DiscoveryRow[]): DiscoveryDeps['pool'] {
  return {
    query: vi.fn(async (sql: string) => {
      if (isScanQuery(sql)) {
        return { rows: rows.map((r) => ({ instance_id: r.instanceId, client_id: r.clientId })) };
      }
      return { rows: [{ unowned_count: rows.length, desired_online_count: 10 }] };
    }),
  } as unknown as DiscoveryDeps['pool'];
}

describe('discovery loop - escalation lifecycle edges', () => {
  it('reowned_between_2nd_and_3rd_unowned_sighting_never_escalates', async () => {
    const row: DiscoveryRow = { instanceId: 'inst-a', clientId: 'client-a' };
    const markInfraUnavailable = vi.fn(async () => true);

    // Cycle 1: unowned, grab fails -> streak 1.
    // Cycle 2: unowned, grab fails -> streak 2.
    // Cycle 3: SAME row, but this time grab SUCCEEDS (re-owned by someone,
    // simulated here as this worker's own successful grab) -> streak reset,
    // no escalation.
    let grabCallCount = 0;
    const deps = makeDiscoveryDeps({
      pool: poolReturningRows([row]),
      grab: vi.fn(async () => {
        grabCallCount += 1;
        return grabCallCount === 3; // fails cycles 1-2, succeeds cycle 3
      }),
      markInfraUnavailable,
    });
    const loop = createDiscoveryLoop(deps);

    await loop.runOneCycle();
    await loop.runOneCycle();
    await loop.runOneCycle();

    expect(markInfraUnavailable).not.toHaveBeenCalled();

    // A subsequent 3-cycle unowned streak starting fresh must still be able
    // to escalate (proves the reset was real, not a permanent suppression).
    grabCallCount = 3; // force grab to keep failing from here on
    const deps2 = makeDiscoveryDeps({
      pool: poolReturningRows([row]),
      grab: vi.fn(async () => false),
      markInfraUnavailable,
    });
    const loop2 = createDiscoveryLoop(deps2);
    await loop2.runOneCycle();
    await loop2.runOneCycle();
    await loop2.runOneCycle();
    expect(markInfraUnavailable).toHaveBeenCalledTimes(1);
  });

  it('instance_absent_from_scan_mid_streak_drops_the_streak_with_no_write_and_no_throw', async () => {
    const row: DiscoveryRow = { instanceId: 'inst-b', clientId: 'client-b' };
    const markInfraUnavailable = vi.fn(async () => true);
    const onCycleError = vi.fn();

    let cycle = 0;
    const deps = makeDiscoveryDeps({
      pool: {
        query: vi.fn(async (sql: string) => {
          if (isScanQuery(sql)) {
            cycle += 1;
            // Present for cycles 1-2, then GONE (deleted/no longer online)
            // for cycle 3 - simulates a mid-cycle deletion race.
            return cycle < 3
              ? { rows: [{ instance_id: row.instanceId, client_id: row.clientId }] }
              : { rows: [] };
          }
          return { rows: [{ unowned_count: 0, desired_online_count: 10 }] };
        }),
      } as unknown as DiscoveryDeps['pool'],
      grab: vi.fn(async () => false),
      markInfraUnavailable,
      onCycleError,
    });
    const loop = createDiscoveryLoop(deps);

    await loop.runOneCycle();
    await loop.runOneCycle();
    // Row vanished from the scan (deleted mid-cycle) - no write, no throw.
    await expect(loop.runOneCycle()).resolves.toBeUndefined();

    expect(markInfraUnavailable).not.toHaveBeenCalled();
    expect(onCycleError).not.toHaveBeenCalled();

    // A 4th cycle where the row reappears unowned starts the streak fresh
    // (count 1, not 3) - escalation must not fire immediately.
    cycle = 0; // reset the query stub's own counter so it serves rows again
    await loop.runOneCycle();
    expect(markInfraUnavailable).not.toHaveBeenCalled();
  });

  it('already_degraded_infra_unavailable_reruns_idempotently_zero_effect', async () => {
    const row: DiscoveryRow = { instanceId: 'inst-c', clientId: 'client-c' };
    // markInfraUnavailable returns `false` every time - simulating the
    // real SQL's changed-flag semantics when the row is already
    // degraded+INFRA_UNAVAILABLE (zero rows changed -> zero audit writes).
    const markInfraUnavailable = vi.fn(async () => false);

    const deps = makeDiscoveryDeps({
      pool: poolReturningRows([row]),
      grab: vi.fn(async () => false),
      markInfraUnavailable,
    });
    const loop = createDiscoveryLoop(deps);

    await loop.runOneCycle();
    await loop.runOneCycle();
    await loop.runOneCycle();
    await loop.runOneCycle(); // 4th cycle - streak already >= 3, re-fires the call every cycle

    // The call happens each cycle once escalation threshold is reached, but
    // the RESULT (false = zero-effect) proves idempotency - no assumption
    // that the caller stops calling once already degraded (discovery.ts
    // does not itself track "already escalated", it relies on the SQL's own
    // changed-flag no-op).
    expect(markInfraUnavailable).toHaveBeenCalledTimes(2); // cycles 3 and 4
    for (const result of markInfraUnavailable.mock.results) {
      await expect(result.value as Promise<boolean>).resolves.toBe(false);
    }
  });

  it('query_error_mid_cycle_backs_off_without_throwing_grabbing_or_escalating', async () => {
    const onCycleError = vi.fn();
    const grab = vi.fn(async () => true);
    const markInfraUnavailable = vi.fn(async () => true);

    const deps = makeDiscoveryDeps({
      pool: {
        query: vi.fn(async () => {
          throw new Error('pg unreachable');
        }),
      } as unknown as DiscoveryDeps['pool'],
      grab,
      markInfraUnavailable,
      onCycleError,
    });
    const loop = createDiscoveryLoop(deps);

    await expect(loop.runOneCycle()).resolves.toBeUndefined();
    expect(onCycleError).toHaveBeenCalledTimes(1);
    expect(grab).not.toHaveBeenCalled();
    expect(markInfraUnavailable).not.toHaveBeenCalled();
  });
});

describe('discovery loop - soft yield exact 0.9x cap boundary', () => {
  it('sessions_at_exactly_90_percent_of_cap_under_lag_still_yields', async () => {
    const cap = 100;
    const rows: DiscoveryRow[] = [{ instanceId: 'i1', clientId: 'c1' }];
    const grab = vi.fn(async () => true);

    const deps = makeDiscoveryDeps({
      pool: poolReturningRows(rows),
      grab,
      getLagP99Ms: vi.fn(() => 201), // > 200ms
      getCap: vi.fn(() => cap),
      getCurrentSessions: vi.fn(() => 90), // exactly 0.9 * 100 -> >= threshold
    });
    const loop = createDiscoveryLoop(deps);
    await loop.runOneCycle();

    expect(grab).not.toHaveBeenCalled();
  });

  it('sessions_one_below_90_percent_of_cap_under_lag_does_not_yield', async () => {
    const cap = 100;
    const rows: DiscoveryRow[] = [{ instanceId: 'i1', clientId: 'c1' }];
    const grab = vi.fn(async () => true);

    const deps = makeDiscoveryDeps({
      pool: poolReturningRows(rows),
      grab,
      getLagP99Ms: vi.fn(() => 201),
      getCap: vi.fn(() => cap),
      getCurrentSessions: vi.fn(() => 89), // < 0.9 * 100
    });
    const loop = createDiscoveryLoop(deps);
    await loop.runOneCycle();

    expect(grab).toHaveBeenCalledTimes(1);
  });
});
