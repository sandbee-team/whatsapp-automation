import { describe, expect, it, vi } from 'vitest';
import { TIMING } from '@wp/domain';
import { tenantKey } from '../../platform/redis/keys.js';
import { LeaseManager, type TenantTxRunner } from './lease-manager.js';
import {
  TEST_TIMING,
  makeDeps,
  makeTenantDb,
  makeUncalledTenantDb,
} from './test-support/lease-manager-fixtures.js';

/**
 * lease-manager.test.ts (P06 Unit U4) - unit-level proof of the FIXED
 * five-step `acquire()` order using stub redis/repo/tenantDb (no real
 * Redis/Postgres I/O - the real-infra proof lives in
 * lease-fence.concurrency.integration.test.ts's
 * `two_workers_cannot_hold_one_session` case).
 *
 * `LeaseManager.release()`'s tests live in `lease-manager.release.test.ts`
 * (same fixtures, split out to keep this file under the workspace
 * max-lines limit).
 */

describe('LeaseManager.acquire', () => {
  it('mint_throw_releases_placeholder_and_returns_null', async () => {
    const releaseSpy = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      leaseRedis: { release: releaseSpy },
      tenantDb: makeTenantDb({ rejectWith: new Error('pg unavailable') }),
    });
    const manager = new LeaseManager(deps);

    const result = await manager.acquire({ instanceId: 'inst-1', clientId: 'client-1' });

    expect(result).toBeNull();
    expect(releaseSpy).toHaveBeenCalledWith(
      tenantKey('test', 'client-1', 'lease', 'i', 'inst-1'),
      'worker-1|PENDING',
    );
  });

  it('set_fence_returning_zero_releases_nothing_and_returns_null', async () => {
    const releaseSpy = vi.fn().mockResolvedValue(true);
    const setFenceSpy = vi.fn().mockResolvedValue(false);
    const deps = makeDeps({
      leaseRedis: { setFence: setFenceSpy, release: releaseSpy },
      tenantDb: makeTenantDb({
        result: { fence: 5n, prevReleasedAt: null, prevOwnerWorkerId: null },
      }),
    });
    const manager = new LeaseManager(deps);

    const result = await manager.acquire({ instanceId: 'inst-1', clientId: 'client-1' });

    expect(result).toBeNull();
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('fresh_prev_released_at_skips_grace', async () => {
    // `acquire()` never awaits the grace itself (P09 fleet-recovery FIX: an
    // inline await here would serialize discovery.ts's sequential grab
    // loop) - it computes the duration and returns it as
    // `SessionLease.graceMs` for the caller to wait out, deferred and
    // cancellable. This test observes that computed duration directly.
    const now = () => new Date('2026-08-31T00:01:00.000Z');
    const prevReleasedAt = new Date('2026-08-31T00:00:30.000Z'); // 30s ago, within 60s freshness
    const deps = makeDeps({
      tenantDb: makeTenantDb({ result: { fence: 7n, prevReleasedAt, prevOwnerWorkerId: null } }),
      now,
    });
    const manager = new LeaseManager(deps);

    const result = await manager.acquire({ instanceId: 'inst-1', clientId: 'client-1' });

    expect(result).toEqual({
      instanceId: 'inst-1',
      clientId: 'client-1',
      fence: 7n,
      workerId: 'worker-1',
      graceMs: 0,
    });
  });

  it('stale_prev_released_at_reports_full_grace', async () => {
    const now = () => new Date('2026-08-31T00:10:00.000Z');
    const prevReleasedAt = new Date('2026-08-31T00:00:00.000Z'); // 10 minutes ago, stale
    const deps = makeDeps({
      tenantDb: makeTenantDb({ result: { fence: 9n, prevReleasedAt, prevOwnerWorkerId: null } }),
      now,
    });
    const manager = new LeaseManager(deps);

    const result = await manager.acquire({ instanceId: 'inst-1', clientId: 'client-1' });

    expect(result).toEqual({
      instanceId: 'inst-1',
      clientId: 'client-1',
      fence: 9n,
      workerId: 'worker-1',
      graceMs: TEST_TIMING.takeoverGraceMs,
    });
  });

  it('null_prev_released_at_reports_full_grace', async () => {
    const deps = makeDeps({
      tenantDb: makeTenantDb({
        result: { fence: 1n, prevReleasedAt: null, prevOwnerWorkerId: null },
      }),
    });
    const manager = new LeaseManager(deps);

    const result = await manager.acquire({ instanceId: 'inst-1', clientId: 'client-1' });

    expect(result?.fence).toBe(1n);
    expect(result?.graceMs).toBe(TEST_TIMING.takeoverGraceMs);
  });

  it('acquire_never_awaits_the_grace_inline_so_it_resolves_before_a_real_takeover_grace_elapses', async () => {
    // The proof that matters for the fleet-recovery property: `acquire()`
    // must settle fast even when the real, uncompressed TIMING.takeoverGraceMs
    // applies (a never-released, previously-owned instance) - it must NOT
    // be the one blocking discovery.ts's sequential grab loop. Uses REAL
    // TIMING (not TEST_TIMING) so a regression that reintroduces an inline
    // `await sleep(takeoverGraceMs)` (30s in production TIMING) would time
    // this test out, not just silently pass with a small stub timing value.
    const deps = makeDeps({
      tenantDb: makeTenantDb({
        result: { fence: 1n, prevReleasedAt: null, prevOwnerWorkerId: 'worker-old' },
      }),
    });
    deps.timing = TIMING;
    const manager = new LeaseManager(deps);

    const startedAt = Date.now();
    const result = await manager.acquire({ instanceId: 'inst-1', clientId: 'client-1' });
    const elapsedMs = Date.now() - startedAt;

    expect(result?.graceMs).toBe(TIMING.takeoverGraceMs);
    // Generous ceiling: real production takeoverGraceMs is 15_000ms - this
    // must resolve orders of magnitude faster than that, never anywhere
    // close to it.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('nx_placeholder_lost_returns_null_without_touching_postgres', async () => {
    const acquireSpy = vi.fn().mockResolvedValue(false);
    const { tenantDb, spy: withTenantSpy } = makeUncalledTenantDb();
    const deps = makeDeps({
      leaseRedis: { acquire: acquireSpy },
      tenantDb,
    });
    const manager = new LeaseManager(deps);

    const result = await manager.acquire({ instanceId: 'inst-1', clientId: 'client-1' });

    expect(result).toBeNull();
    expect(withTenantSpy).not.toHaveBeenCalled();
  });

  it('a_different_previous_owner_increments_takeovers_but_a_first_ever_mint_does_not', async () => {
    const incrementTakeovers = vi.fn();
    const depsFirstMint = makeDeps({
      tenantDb: makeTenantDb({
        result: { fence: 1n, prevReleasedAt: null, prevOwnerWorkerId: null },
      }),
    });
    depsFirstMint.metrics = { incrementTakeovers, incrementFenceRegression: vi.fn() };
    const managerFirstMint = new LeaseManager(depsFirstMint);
    await managerFirstMint.acquire({ instanceId: 'inst-1', clientId: 'client-1' });
    expect(incrementTakeovers).not.toHaveBeenCalled();

    const depsTakeover = makeDeps({
      tenantDb: makeTenantDb({
        result: { fence: 2n, prevReleasedAt: null, prevOwnerWorkerId: 'worker-OLD' },
      }),
    });
    depsTakeover.metrics = { incrementTakeovers, incrementFenceRegression: vi.fn() };
    const managerTakeover = new LeaseManager(depsTakeover);
    await managerTakeover.acquire({ instanceId: 'inst-1', clientId: 'client-1' });
    expect(incrementTakeovers).toHaveBeenCalledTimes(1);
  });

  it('a_worker_re_minting_its_own_lease_does_not_count_as_a_takeover', async () => {
    const incrementTakeovers = vi.fn();
    const deps = makeDeps({
      tenantDb: makeTenantDb({
        result: { fence: 3n, prevReleasedAt: null, prevOwnerWorkerId: 'worker-1' },
      }),
    });
    deps.metrics = { incrementTakeovers, incrementFenceRegression: vi.fn() };
    const manager = new LeaseManager(deps); // workerId defaults to 'worker-1' in makeDeps

    await manager.acquire({ instanceId: 'inst-1', clientId: 'client-1' });

    expect(incrementTakeovers).not.toHaveBeenCalled();
  });

  it('a_fence_not_strictly_greater_than_the_last_seen_fence_increments_fence_regression', async () => {
    const incrementFenceRegression = vi.fn();
    let call = 0;
    const tenantDb: TenantTxRunner = {
      withTenant: vi.fn(async () => {
        call += 1;
        // First acquire mints fence 5; second acquire (simulating a
        // regression) mints fence 5 again - not strictly greater.
        return call === 1
          ? { fence: 5n, prevReleasedAt: null, prevOwnerWorkerId: null }
          : { fence: 5n, prevReleasedAt: null, prevOwnerWorkerId: 'worker-1' };
      }),
    } as unknown as TenantTxRunner;

    const deps = makeDeps({ tenantDb });
    deps.metrics = { incrementTakeovers: vi.fn(), incrementFenceRegression };
    const manager = new LeaseManager(deps);

    await manager.acquire({ instanceId: 'inst-1', clientId: 'client-1' });
    expect(incrementFenceRegression).not.toHaveBeenCalled();

    await manager.acquire({ instanceId: 'inst-1', clientId: 'client-1' });
    expect(incrementFenceRegression).toHaveBeenCalledTimes(1);
  });
});
