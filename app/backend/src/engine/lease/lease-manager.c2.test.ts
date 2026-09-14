import { describe, expect, it, vi } from 'vitest';
import { LeaseManager, type LeaseManagerDeps, type TenantTxRunner } from './lease-manager.js';
import type { LeaseRedis } from './lease-redis.js';
import type { MintFenceCtx, MintFenceResult } from './lease-state-repo.js';
import type { SessionOwner } from './session-owner.port.js';

/**
 * lease-manager.c2.test.ts (P06 C2 all-cases pass) - probe 5: wall-clock
 * boundary on the grace-skip when `released_at` is in the FUTURE relative
 * to the acquiring worker's clock (cross-worker clock skew). NOT covered by
 * lease-manager.edge.test.ts (which only probes the 60s boundary with a
 * released_at that is in the PAST).
 */

const TEST_TIMING = {
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

function makeSessionOwner(): SessionOwner {
  return {
    onFenceLost: vi.fn(),
    close: vi.fn(),
  };
}

function makeTenantDb(options: { result?: MintFenceResult; rejectWith?: unknown }): TenantTxRunner {
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

function makeDeps(overrides: {
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

describe('probe 5: wall-clock boundary on the grace-skip (cross-worker clock skew)', () => {
  it('released_at_in_the_future_relative_to_the_acquiring_workers_clock_MUST_NOT_skip_the_grace', async () => {
    // FIX-2 (C1 WARNING 5 / C2 REAL FINDING 2): lease-manager.ts's freshness
    // check must use `delta = now - released` and skip the grace only when
    // `delta >= 0 && delta < RELEASE_FRESHNESS_MS`. A future-dated
    // `released_at` (clock skew / NTP drift between workers) makes the raw
    // subtraction negative - that must NO LONGER be treated as "clean and
    // recent"; the grace must be WAITED, closing the two-owner overlap
    // window the grace period exists to protect (see lease-manager.ts's own
    // acquire() step-4 doc: "so a not-yet-self-fenced previous owner has a
    // chance to notice first").
    const prevReleasedAt = new Date('2026-08-31T00:05:00.000Z'); // 5 minutes in the FUTURE
    const acquiringWorkerNow = new Date('2026-08-31T00:00:00.000Z');

    const deps = makeDeps({
      tenantDb: makeTenantDb({
        result: { fence: 2n, prevReleasedAt, prevOwnerWorkerId: 'worker-old' },
      }),
      now: () => acquiringWorkerNow,
    });

    const manager = new LeaseManager(deps);
    const result = await manager.acquire({
      instanceId: 'inst-future-release',
      clientId: 'client-1',
    });

    expect(result).not.toBeNull();

    // FIXED BEHAVIOR: the returned lease's `graceMs` carries the full grace
    // duration for a future-dated released_at - a negative delta is no
    // longer treated as "fresher than fresh". `acquire()` itself never
    // awaits this any more (P09 fleet-recovery FIX) - the caller waits it
    // out, deferred/cancellable.
    expect(result?.graceMs).toBe(TEST_TIMING.takeoverGraceMs);
    expect(result?.fence).toBe(2n);
  });

  it('released_at_far_in_the_future_relative_to_now_still_waits_the_grace_same_fix_at_a_larger_skew', async () => {
    // Same fix, larger skew (1 hour), to confirm this is not a narrow
    // boundary artifact but a structural property of the signed-delta check.
    const prevReleasedAt = new Date('2026-08-31T01:00:00.000Z');
    const acquiringWorkerNow = new Date('2026-08-31T00:00:00.000Z');

    const deps = makeDeps({
      tenantDb: makeTenantDb({
        result: { fence: 3n, prevReleasedAt, prevOwnerWorkerId: 'worker-old' },
      }),
      now: () => acquiringWorkerNow,
    });

    const manager = new LeaseManager(deps);
    const result = await manager.acquire({
      instanceId: 'inst-future-release-2',
      clientId: 'client-1',
    });

    expect(result).not.toBeNull();
    expect(result?.graceMs).toBe(TEST_TIMING.takeoverGraceMs);
  });
});
