import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import {
  createDiscoveryLoop,
  readFleetCapacityHeadroom,
  type DiscoveryDeps,
  type DiscoveryRow,
} from './discovery.js';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindDiscoveryMetrics } from '../../platform/metrics/discovery-metrics.js';

/**
 * discovery.test.ts (P09 Unit U3 step 5) - the two pure-logic named unit
 * tests: admission gating (zero grab calls while holding) and the soft-yield
 * threshold under sustained lag. Both drive `runOneCycle()` directly
 * (deterministic, no timers) with fully injected deps - no real Postgres/
 * Redis. A fresh `createMetricsRegistry()` is used per test (module-level
 * default registry would throw on double-registration across files).
 */

function makeDeps(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
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

describe('discovery loop', () => {
  it('discovery_stops_grabbing_when_admission_is_holding', async () => {
    const deps = makeDeps({
      admission: { canAcceptLease: vi.fn(() => ({ ok: false, state: 'holding' })) },
    });
    const loop = createDiscoveryLoop(deps);

    await loop.runOneCycle();

    expect(deps.grab).not.toHaveBeenCalled();
    // Holding also skips the scan/gauges query entirely for this cycle.
    expect(deps.pool.query).not.toHaveBeenCalled();
  });

  it('discovery_soft_yields_at_ninety_percent_cap_under_lag', async () => {
    const cap = 100;
    // 91 current sessions is already >= 0.9 * cap (90) - the soft-yield
    // threshold is breached from the first row onward under sustained lag.
    const rows: DiscoveryRow[] = [
      { instanceId: 'i1', clientId: 'c1' },
      { instanceId: 'i2', clientId: 'c2' },
    ];

    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('wp_lease_scan_unowned')) {
          return {
            rows: rows.map((r) => ({ instance_id: r.instanceId, client_id: r.clientId })),
          };
        }
        // fleet-gauges.sql
        return { rows: [{ unowned_count: 2, desired_online_count: 10 }] };
      }),
    } as unknown as DiscoveryDeps['pool'];

    const grab = vi.fn(async () => true);

    const deps = makeDeps({
      pool,
      grab,
      getLagP99Ms: vi.fn(() => 250), // > 200ms
      getCap: vi.fn(() => cap),
      getCurrentSessions: vi.fn(() => 91), // >= 0.9 * 100
    });

    const loop = createDiscoveryLoop(deps);
    await loop.runOneCycle();

    expect(grab).not.toHaveBeenCalled();
  });
});

describe('escalation streak ownership re-verification (WARNING FIX 5)', () => {
  function makePoolReturning(row: DiscoveryRow): DiscoveryDeps['pool'] {
    return {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('unowned_count')) {
          return { rows: [{ unowned_count: 1, desired_online_count: 1 }] };
        }
        return { rows: [{ instance_id: row.instanceId, client_id: row.clientId }] };
      }),
    } as unknown as DiscoveryDeps['pool'];
  }

  it('an instance grabbed by another worker every cycle (fresh ownership) never escalates', async () => {
    const row: DiscoveryRow = { instanceId: 'inst-contended', clientId: 'client-1' };
    const markInfraUnavailable = vi.fn(async () => true);
    const isOwnershipFresh = vi.fn(async () => true); // always fresh - contended, healthy

    const deps = makeDeps({
      pool: makePoolReturning(row),
      grab: vi.fn(async () => false), // loses the grab race every cycle
      markInfraUnavailable,
      isOwnershipFresh,
    });
    const loop = createDiscoveryLoop(deps);

    for (let i = 0; i < 5; i++) {
      await loop.runOneCycle();
    }

    expect(isOwnershipFresh).toHaveBeenCalled();
    expect(markInfraUnavailable).not.toHaveBeenCalled();
  });

  it('a truly-unowned instance (never fresh) still escalates at 3 consecutive cycles', async () => {
    const row: DiscoveryRow = { instanceId: 'inst-unowned', clientId: 'client-1' };
    const markInfraUnavailable = vi.fn(async () => true);
    const isOwnershipFresh = vi.fn(async () => false); // genuinely unowned

    const deps = makeDeps({
      pool: makePoolReturning(row),
      grab: vi.fn(async () => false),
      markInfraUnavailable,
      isOwnershipFresh,
    });
    const loop = createDiscoveryLoop(deps);

    await loop.runOneCycle();
    expect(markInfraUnavailable).not.toHaveBeenCalled();
    await loop.runOneCycle();
    expect(markInfraUnavailable).not.toHaveBeenCalled();
    await loop.runOneCycle();
    expect(markInfraUnavailable).toHaveBeenCalledTimes(1);
    expect(markInfraUnavailable).toHaveBeenCalledWith(row);
  });

  it('omitting isOwnershipFresh (unwired caller) preserves the pre-fix behavior: every failed grab counts', async () => {
    const row: DiscoveryRow = { instanceId: 'inst-unwired', clientId: 'client-1' };
    const markInfraUnavailable = vi.fn(async () => true);

    const deps = makeDeps({
      pool: makePoolReturning(row),
      grab: vi.fn(async () => false),
      markInfraUnavailable,
    });
    delete (deps as { isOwnershipFresh?: unknown }).isOwnershipFresh;
    const loop = createDiscoveryLoop(deps);

    await loop.runOneCycle();
    await loop.runOneCycle();
    await loop.runOneCycle();
    expect(markInfraUnavailable).toHaveBeenCalledTimes(1);
  });
});

describe('readFleetCapacityHeadroom stale-field pruning (WARNING FIX 7)', () => {
  it('prunes a large stale-field set in bounded chunks rather than one unbounded HDEL call', async () => {
    const STALE_COUNT = 600; // > 2x the 256 chunk size, forcing 3 chunks
    const store: Record<string, string> = {};
    for (let i = 0; i < STALE_COUNT; i++) {
      // at=0, now() far past CAP_FRESHNESS_MS - every field is stale.
      store[`worker-${String(i)}`] = JSON.stringify({ cap: 1, at: 0 });
    }

    const hdelCalls: string[][] = [];
    const redis = {
      hgetall: vi.fn(async () => store),
      hdel: vi.fn(async (_key: string, ...fields: string[]) => {
        hdelCalls.push(fields);
        return fields.length;
      }),
    } as unknown as DiscoveryDeps['redis'];

    const headroom = await readFleetCapacityHeadroom({
      redis,
      env: 'test',
      desiredOnlineCount: 0,
      now: () => 1_000_000,
    });

    // Every stale field was pruned across MULTIPLE bounded calls, none
    // exceeding the 256-field chunk size.
    expect(headroom).toBe(0 - 0);
    expect(hdelCalls.length).toBeGreaterThan(1);
    for (const chunk of hdelCalls) {
      expect(chunk.length).toBeLessThanOrEqual(256);
    }
    const totalPruned = hdelCalls.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(totalPruned).toBe(STALE_COUNT);
  });
});
