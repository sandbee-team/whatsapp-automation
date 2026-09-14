import { describe, expect, it, vi } from 'vitest';
import { tenantKey } from '../../platform/redis/keys.js';
import { LeaseManager } from './lease-manager.js';
import type { SessionOwner } from './session-owner.port.js';
import { makeCallingTenantDb, makeDeps } from './test-support/lease-manager-fixtures.js';

/**
 * lease-manager.release.test.ts (P06 Unit U5) - unit-level proof of
 * `LeaseManager.release()`'s FIXED order (close -> redis delete -> pg
 * release), split out of lease-manager.test.ts (which keeps
 * `LeaseManager.acquire`'s tests) to stay under the workspace max-lines
 * limit. Shares fixtures with lease-manager.test.ts via
 * test-support/lease-manager-fixtures.ts.
 */

describe('LeaseManager.release', () => {
  it('graceful_release_runs_close_then_redis_delete_then_pg_release', async () => {
    const calls: string[] = [];
    const sessionOwner: SessionOwner = {
      onFenceLost: vi.fn(),
      close: vi.fn(async () => {
        calls.push('close');
      }),
    };
    const releaseRedisSpy = vi.fn(async () => {
      calls.push('redis-release');
      return true;
    });
    const pgReleaseSpy = vi.fn(async () => {
      calls.push('pg-release');
      return true;
    });

    const deps = makeDeps({ sessionOwner, tenantDb: makeCallingTenantDb() });
    deps.leaseRedis.release = releaseRedisSpy;
    const manager = new LeaseManager(deps, { pgRelease: pgReleaseSpy });

    const lease = {
      instanceId: 'inst-1',
      clientId: 'client-1',
      fence: 5n,
      workerId: 'worker-1',
      graceMs: 0,
    };
    await manager.release(lease);

    expect(calls).toEqual(['close', 'redis-release', 'pg-release']);
    expect(releaseRedisSpy).toHaveBeenCalledWith(
      tenantKey('test', 'client-1', 'lease', 'i', 'inst-1'),
      'worker-1|5',
    );
    expect(pgReleaseSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instanceId: 'inst-1', fence: 5n, workerId: 'worker-1' }),
    );
  });

  it('redis_release_error_is_logged_and_pg_release_still_attempted', async () => {
    const sessionOwner: SessionOwner = { onFenceLost: vi.fn(), close: vi.fn() };
    const releaseRedisSpy = vi.fn().mockRejectedValue(new Error('redis down'));
    const pgReleaseSpy = vi.fn().mockResolvedValue(true);
    const errorLog = vi.fn();

    const deps = makeDeps({ sessionOwner, tenantDb: makeCallingTenantDb() });
    deps.leaseRedis.release = releaseRedisSpy;
    deps.logger = { info: vi.fn(), warn: vi.fn(), error: errorLog };
    const manager = new LeaseManager(deps, { pgRelease: pgReleaseSpy });

    const lease = {
      instanceId: 'inst-1',
      clientId: 'client-1',
      fence: 5n,
      workerId: 'worker-1',
      graceMs: 0,
    };
    await manager.release(lease);

    expect(errorLog).toHaveBeenCalled();
    expect(pgReleaseSpy).toHaveBeenCalled();
  });

  it('zero_row_pg_release_is_logged_never_thrown', async () => {
    const sessionOwner: SessionOwner = { onFenceLost: vi.fn(), close: vi.fn() };
    const pgReleaseSpy = vi.fn().mockResolvedValue(false);
    const warnLog = vi.fn();

    const deps = makeDeps({ sessionOwner, tenantDb: makeCallingTenantDb() });
    deps.logger = { info: vi.fn(), warn: warnLog, error: vi.fn() };
    const manager = new LeaseManager(deps, { pgRelease: pgReleaseSpy });

    const lease = {
      instanceId: 'inst-1',
      clientId: 'client-1',
      fence: 5n,
      workerId: 'worker-1',
      graceMs: 0,
    };
    await expect(manager.release(lease)).resolves.toBeUndefined();

    expect(warnLog).toHaveBeenCalled();
  });
});
