import { vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindDiscoveryMetrics } from '../../../platform/metrics/discovery-metrics.js';
import type { DiscoveryDeps } from '../discovery.js';

/**
 * fleet-c2-unit-test-support.ts (FIX-P09-B split) - shared `makeDiscoveryDeps`
 * fixture for `fleet-c2-unit.test.ts`'s split files, mechanically extracted
 * at FIX-P09-B for the max-lines cap. No logic change - same helper, same
 * behavior. Lives under `__tests__/` alongside this dispatch's other
 * real-DB test-support files for consistency (this one has no DB queries
 * of its own, but keeping every FIX-P09-B support file in one place avoids
 * a mixed convention within the same fleet split).
 */

export function makeDiscoveryDeps(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
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
