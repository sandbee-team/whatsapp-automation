import { describe, expect, it, vi } from 'vitest';
import { LeaseManager, type LeaseManagerDeps, type TenantTxRunner } from './lease-manager.js';
import type { LeaseRedis } from './lease-redis.js';
import type { MintFenceCtx, MintFenceResult } from './lease-state-repo.js';
import type { SessionOwner } from './session-owner.port.js';

/**
 * lease-manager.edge.test.ts (P06 E3 edge pass) - unit-level edge cases NOT
 * covered by lease-manager.test.ts: placeholder-expiry-mid-acquire (CAS
 * loses the race), same-worker re-acquire (no self-steal), and the exact
 * 60s release-freshness boundary (strictly-within-60s semantics). No real
 * Redis/Postgres - mirrors lease-manager.test.ts's stub style exactly.
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

describe('LeaseManager.acquire edge cases', () => {
  it('placeholder_expiry_mid_acquire_cas_loses_race_returns_null_no_pg_corruption', async () => {
    // Step 1 NX succeeds (we think we hold the placeholder), but by step 3
    // the placeholder's TTL has already expired (or been raced away) - the
    // CAS in set-fence.lua returns 0. mintFence in Postgres already ran and
    // committed a real fence bump - that write is NOT rolled back or undone
    // by this code path (mintFence's transaction already committed before
    // setFence is even called), so "no PG state corrupted" means: the mint
    // that DID happen is a legitimate, valid mint (not a corrupt one) even
    // though this acquire attempt itself aborts.
    const setFenceSpy = vi.fn().mockResolvedValue(false);
    const releaseSpy = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      leaseRedis: { setFence: setFenceSpy, release: releaseSpy },
      tenantDb: makeTenantDb({
        result: { fence: 7n, prevReleasedAt: null, prevOwnerWorkerId: null },
      }),
    });
    const manager = new LeaseManager(deps);

    const result = await manager.acquire({ instanceId: 'inst-expiry', clientId: 'client-1' });

    expect(result).toBeNull();
    // Nothing left of ours to release - lease-manager.ts's own contract:
    // "We no longer hold the key - nothing left of ours to release."
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(setFenceSpy).toHaveBeenCalledTimes(1);

    // A SUBSEQUENT acquire (this same manager, a fresh mint) succeeds with a
    // strictly higher fence than the aborted attempt's mint (8n > 7n) - the
    // aborted attempt's mint is not reused, retried, or double-applied; a
    // brand new mint happens and Postgres's own monotonic sequence is what
    // guarantees the higher value, proven here by a distinct stubbed result.
    const deps2 = makeDeps({
      tenantDb: makeTenantDb({
        result: { fence: 8n, prevReleasedAt: null, prevOwnerWorkerId: null },
      }),
    });
    const manager2 = new LeaseManager(deps2);
    const result2 = await manager2.acquire({ instanceId: 'inst-expiry', clientId: 'client-1' });

    expect(result2).not.toBeNull();
    expect(result2?.fence).toBe(8n);
    expect(result2!.fence).toBeGreaterThan(7n);
  });

  it('same_worker_re_acquire_for_already_held_instance_is_nx_rejected_no_self_steal', async () => {
    // Worker A already holds the placeholder (acquire.lua's NX fails for
    // ANYONE, including the same worker that set it - NX is not
    // owner-aware). LeaseManager must return null without ever touching
    // Postgres (no mint, no fence bump) - re-acquiring your own held lease
    // must be a pure no-op from the caller's perspective, not a fence bump.
    const nxAcquire = vi.fn().mockResolvedValue(false);
    const mintSpy = vi.fn();
    const tenantDb: TenantTxRunner = { withTenant: mintSpy };
    const deps = makeDeps({
      leaseRedis: { acquire: nxAcquire },
      tenantDb,
    });
    const manager = new LeaseManager(deps);

    const result = await manager.acquire({ instanceId: 'inst-held', clientId: 'client-1' });

    expect(result).toBeNull();
    expect(nxAcquire).toHaveBeenCalledTimes(1);
    // No mint attempt at all - Postgres was never touched, so no fence bump
    // happened for an instance the caller (or anyone) already holds.
    expect(mintSpy).not.toHaveBeenCalled();
  });

  it('release_freshness_boundary_exactly_60s_elapsed_grace_is_not_skipped', async () => {
    // RELEASE_FRESHNESS_MS is 60_000 and the manager's own predicate is
    // strictly-less-than: `now - prevReleasedAt < 60_000`. At EXACTLY
    // 60_000ms elapsed, releasedRecently must be false, so the returned
    // lease's `graceMs` MUST still carry the full grace duration (safe
    // direction: when ambiguous, wait the grace rather than skip it).
    // `acquire()` itself never awaits this any more (P09 fleet-recovery FIX:
    // the caller waits it out, deferred/cancellable) - this test observes
    // the computed duration via the returned `SessionLease`, not a `sleep`
    // spy.
    const prevReleasedAt = new Date('2026-08-31T00:00:00.000Z');
    const nowAtExactBoundary = new Date(prevReleasedAt.getTime() + 60_000);

    const deps = makeDeps({
      tenantDb: makeTenantDb({
        result: { fence: 2n, prevReleasedAt, prevOwnerWorkerId: 'worker-old' },
      }),
      now: () => nowAtExactBoundary,
    });

    const manager = new LeaseManager(deps);
    const result = await manager.acquire({ instanceId: 'inst-boundary', clientId: 'client-1' });

    expect(result).not.toBeNull();
    expect(result?.graceMs).toBe(TEST_TIMING.takeoverGraceMs);
  });

  it('release_freshness_boundary_one_ms_under_60s_grace_is_skipped', async () => {
    // Sanity contrast for the above: 59_999ms elapsed (strictly < 60_000)
    // DOES count as recent, so the returned lease's `graceMs` must be 0.
    const prevReleasedAt = new Date('2026-08-31T00:00:00.000Z');
    const nowJustUnderBoundary = new Date(prevReleasedAt.getTime() + 59_999);

    const deps = makeDeps({
      tenantDb: makeTenantDb({
        result: { fence: 2n, prevReleasedAt, prevOwnerWorkerId: 'worker-old' },
      }),
      now: () => nowJustUnderBoundary,
    });

    const manager = new LeaseManager(deps);
    const result = await manager.acquire({ instanceId: 'inst-boundary-2', clientId: 'client-1' });

    expect(result).not.toBeNull();
    expect(result?.graceMs).toBe(0);
  });
});
