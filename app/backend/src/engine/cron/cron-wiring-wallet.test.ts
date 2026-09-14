import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { TIMING } from '@wp/domain';
import { tenantKey, sysKey } from '../../platform/redis.js';
import { createWalletCronLoops } from './cron-wiring-wallet.js';
import type { ChargerRedis } from '../../modules/wallet/charger.worker.js';

/**
 * cron-wiring-wallet.test.ts (P18 Unit U5) - unit-level proof of
 * `createWalletCronLoops`'s composition: the charger loop only exists when
 * `redis` is supplied, `start()` arms every loop it returns at the right
 * `TIMING.wallet*` cadence, and the sink it builds writes to the correct
 * Redis keys via `tenantKey`/`sysKey` (never a raw `wp:` literal).
 */

function makeFakePool(): { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) };
}

function makeFakeTenantDb(): { withTenant: ReturnType<typeof vi.fn> } {
  return {
    withTenant: vi.fn(async (_clientId: string, fn: (tx: unknown) => unknown) => fn({})),
  };
}

function makeFakeRedis(): ChargerRedis {
  return {
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue('OK'),
    sadd: vi.fn().mockResolvedValue(1),
    spop: vi.fn().mockResolvedValue([]),
    rpop: vi.fn().mockResolvedValue([]),
  };
}

describe('createWalletCronLoops', () => {
  it('returns_no_charger_loop_when_redis_is_not_supplied', () => {
    const setIntervalFn = vi.fn().mockReturnValue(1 as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();
    const walletMetrics = {
      incDebit: vi.fn(),
      incRefund: vi.fn(),
      setDrift: vi.fn(),
      setClientsEmpty: vi.fn(),
    } as never;

    const loops = createWalletCronLoops({
      pool: makeFakePool() as never,
      tenantDb: makeFakeTenantDb() as never,
      env: 'test',
      walletMetrics,
      setIntervalFn,
      clearIntervalFn,
      logOutcome: () => undefined,
    });

    expect(loops.chargerLoop).toBeUndefined();
    expect(loops.walletRollupLoop).toBeDefined();
    expect(loops.walletReconcileLoop).toBeDefined();
  });

  it('arms_the_charger_rollup_and_reconcile_loops_at_the_right_intervals_when_redis_is_supplied', () => {
    const setIntervalFn = vi.fn().mockReturnValue(1 as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();
    const walletMetrics = {
      incDebit: vi.fn(),
      incRefund: vi.fn(),
      setDrift: vi.fn(),
      setClientsEmpty: vi.fn(),
    } as never;

    const loops = createWalletCronLoops({
      pool: makeFakePool() as never,
      tenantDb: makeFakeTenantDb() as never,
      redis: makeFakeRedis(),
      env: 'test',
      walletMetrics,
      setIntervalFn,
      clearIntervalFn,
      logOutcome: () => undefined,
    });

    expect(loops.chargerLoop).toBeDefined();
    loops.chargerLoop?.start();
    loops.walletRollupLoop.start();
    loops.walletReconcileLoop.start();

    const armedIntervals = setIntervalFn.mock.calls.map((call) => call[1] as number);
    expect(armedIntervals).toContain(TIMING.walletChargerDrainIntervalMs);
    // Rollup/reconcile intervals are jittered (+/- interval/12) - assert the
    // base interval is within the jitter bound, never an exact equality.
    const jitterBound = TIMING.walletRollupIntervalMs / 12;
    const rollupArmed = armedIntervals.find(
      (ms) => Math.abs(ms - TIMING.walletRollupIntervalMs) <= jitterBound,
    );
    const reconcileArmed = armedIntervals.find(
      (ms) => Math.abs(ms - TIMING.walletReconcileIntervalMs) <= jitterBound,
    );
    expect(rollupArmed).toBeDefined();
    expect(reconcileArmed).toBeDefined();
  });

  it('the_sinks_onRepairedSent_writes_the_correct_tenant_list_and_pending_index_keys', async () => {
    const redis = makeFakeRedis();
    const loops = createWalletCronLoops({
      pool: makeFakePool() as never,
      tenantDb: makeFakeTenantDb() as never,
      redis,
      env: 'test',
      walletMetrics: {
        incDebit: vi.fn(),
        incRefund: vi.fn(),
        setDrift: vi.fn(),
        setClientsEmpty: vi.fn(),
      } as never,
      logOutcome: () => undefined,
    });

    await loops.sink.onRepairedSent('attempt-1', 'client-1');

    expect(redis.lpush).toHaveBeenCalledWith(tenantKey('test', 'client-1', 'charge'), 'attempt-1');
    expect(redis.sadd).toHaveBeenCalledWith(
      sysKey('test', 'sys', 'wallet', 'charge-pending'),
      'client-1',
    );
  });
});
