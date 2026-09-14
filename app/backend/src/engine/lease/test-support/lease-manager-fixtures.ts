import { vi } from 'vitest';
import type { LeaseManagerDeps, TenantTxRunner } from '../lease-manager.js';
import type { LeaseRedis } from '../lease-redis.js';
import type { MintFenceCtx, MintFenceResult } from '../lease-state-repo.js';
import type { SessionOwner } from '../session-owner.port.js';

/**
 * lease-manager-fixtures.ts (test-support) - shared stubs/builders for
 * `lease-manager.test.ts` (LeaseManager.acquire) and
 * `lease-manager.release.test.ts` (LeaseManager.release), split out of a
 * single over-300-line test file so both halves use identical fixtures
 * rather than duplicating them.
 */

export const TEST_TIMING = {
  leaseTtlMs: 300,
  heartbeatMs: 100,
  takeoverGraceMs: 150,
  watchdogMs: 150,
  sendTimeoutMs: 1000,
  claimExpiryMs: 2000,
  reaperGraceMs: 500,
  reconcileWindowMs: 5000,
  redisCommandTimeoutMs: 200,
} as const;

export function makeSessionOwner(): SessionOwner {
  return {
    onFenceLost: vi.fn(),
    close: vi.fn(),
  };
}

/** Builds a `TenantTxRunner` whose `withTenant` either resolves to `result` or rejects with `rejectWith`. */
export function makeTenantDb(options: {
  result?: MintFenceResult;
  rejectWith?: unknown;
}): TenantTxRunner {
  return {
    withTenant: vi.fn(
      async (_clientId: string, fn: (tx: MintFenceCtx['sql']) => Promise<unknown>) => {
        void fn;
        if (options.rejectWith !== undefined) {
          throw options.rejectWith;
        }
        return options.result;
      },
    ),
  } as unknown as TenantTxRunner;
}

/** A `TenantTxRunner` whose `withTenant` is never expected to be called. */
export function makeUncalledTenantDb(): {
  tenantDb: TenantTxRunner;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn();
  return { tenantDb: { withTenant: spy } as unknown as TenantTxRunner, spy };
}

/**
 * A `TenantTxRunner` whose `withTenant` ACTUALLY invokes `fn` (with a dummy
 * `sql` stub) and returns its result - `LeaseManager.release()`'s Postgres
 * step runs its call inside this callback (see lease-manager.ts's
 * use-after-release-connection comment), unlike `makeTenantDb` above which
 * `acquire()`'s tests use and which deliberately never calls `fn`.
 */
export function makeCallingTenantDb(): TenantTxRunner {
  return {
    withTenant: vi.fn(
      async (_clientId: string, fn: (tx: MintFenceCtx['sql']) => Promise<unknown>) =>
        fn({ query: vi.fn() }),
    ),
  } as unknown as TenantTxRunner;
}

export function makeDeps(overrides: {
  leaseRedis?: Partial<LeaseRedis>;
  tenantDb?: TenantTxRunner;
  sessionOwner?: SessionOwner;
  now?: () => Date;
}): LeaseManagerDeps {
  const leaseRedis: LeaseRedis = {
    acquire: vi.fn().mockResolvedValue(true),
    setFence: vi.fn().mockResolvedValue(true),
    renewBatch: vi.fn().mockResolvedValue([]),
    release: vi.fn().mockResolvedValue(true),
    ...overrides.leaseRedis,
  };

  const tenantDb: TenantTxRunner =
    overrides.tenantDb ??
    makeTenantDb({ result: { fence: 1n, prevReleasedAt: null, prevOwnerWorkerId: null } });

  return {
    leaseRedis,
    tenantDb,
    sessionOwner: overrides.sessionOwner ?? makeSessionOwner(),
    timing: TEST_TIMING as unknown as LeaseManagerDeps['timing'],
    sleep: vi.fn().mockResolvedValue(undefined),
    now: overrides.now ?? (() => new Date('2026-08-31T00:00:00.000Z')),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    workerId: 'worker-1',
    env: 'test',
  };
}
