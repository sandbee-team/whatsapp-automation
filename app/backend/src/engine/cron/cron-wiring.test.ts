import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { createCronWiring } from './cron-wiring.js';
import type { ObjectStore } from '../../platform/storage/object-store.js';

/**
 * cron-wiring.test.ts (P20 Unit U8, step 8) - unit-level proof that
 * `createCronWiring`'s optional `contactsLoops` is armed only when BOTH
 * `keyProvider` and `objectStore` are supplied, and that `start()`/`stop()`
 * reach every one of its three loops alongside the reaper/reconciler/
 * pacing-evaluator/wallet loops - never a throw, never armed on a partial
 * pair (same optional-dep idiom `cron-wiring-wallet.test.ts` proves for
 * `redis`/the charger loop).
 */

function makeFakePool(): { query: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> } {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return { rows: [{ pg_try_advisory_xact_lock: false }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return {
    query: vi.fn(async () => ({ rows: [] })),
    connect: vi.fn(async () => client),
  };
}

function makeFakeTenantDb(): { withTenant: ReturnType<typeof vi.fn> } {
  return { withTenant: vi.fn(async () => undefined) };
}

function makeFakeKeyProvider(): KeyProvider {
  return { getActive: vi.fn(), get: vi.fn() };
}

function makeFakeObjectStore(): ObjectStore {
  return {
    put: vi.fn(),
    getStream: vi.fn(),
    head: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(async function* () {}),
  };
}

describe('createCronWiring - contactsLoops (P20 Unit U8)', () => {
  it('contactsLoops_is_absent_when_keyProvider_and_objectStore_are_both_omitted', () => {
    const setIntervalFn = vi.fn().mockReturnValue(1 as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();

    const wiring = createCronWiring({
      pool: makeFakePool() as never,
      tenantDb: makeFakeTenantDb() as never,
      env: 'test',
      setIntervalFn,
      clearIntervalFn,
    });

    expect(wiring.contactsLoops).toBeUndefined();
  });

  it('contactsLoops_is_absent_when_only_one_of_the_pair_is_supplied', () => {
    const setIntervalFn = vi.fn().mockReturnValue(1 as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();

    const wiring = createCronWiring({
      pool: makeFakePool() as never,
      tenantDb: makeFakeTenantDb() as never,
      env: 'test',
      setIntervalFn,
      clearIntervalFn,
      keyProvider: makeFakeKeyProvider(),
      // objectStore deliberately omitted.
    });

    expect(wiring.contactsLoops).toBeUndefined();
  });

  it('contactsLoops_is_armed_and_started_stopped_when_both_are_supplied', () => {
    const setIntervalFn = vi.fn().mockReturnValue(1 as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();

    const wiring = createCronWiring({
      pool: makeFakePool() as never,
      tenantDb: makeFakeTenantDb() as never,
      env: 'test',
      setIntervalFn,
      clearIntervalFn,
      keyProvider: makeFakeKeyProvider(),
      objectStore: makeFakeObjectStore(),
    });

    expect(wiring.contactsLoops).toBeDefined();
    expect(wiring.contactsLoops?.importLoop).toBeDefined();
    expect(wiring.contactsLoops?.mirrorReconcileLoop).toBeDefined();
    expect(wiring.contactsLoops?.importPurgeLoop).toBeDefined();

    wiring.start();
    // Every loop this wiring owns - reaper/reconciler/pacing-evaluator/
    // wallet rollup/reconcile plus all three contacts loops - calls
    // setIntervalFn exactly once on start().
    expect(setIntervalFn.mock.calls.length).toBeGreaterThanOrEqual(8);

    wiring.stop();
    expect(clearIntervalFn.mock.calls.length).toBe(setIntervalFn.mock.calls.length);
  });
});

describe('createCronWiring - rollupLoops (P25 Unit U3)', () => {
  it('rollup_loops_are_armed_started_and_stopped', () => {
    const setIntervalFn = vi.fn().mockReturnValue(1 as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();

    const wiring = createCronWiring({
      pool: makeFakePool() as never,
      tenantDb: makeFakeTenantDb() as never,
      env: 'test',
      setIntervalFn,
      clearIntervalFn,
    });

    expect(wiring.rollupLoops).toBeDefined();
    expect(wiring.rollupLoops.metricRollupLoop).toBeDefined();
    expect(wiring.rollupLoops.optoutRateLoop).toBeDefined();

    wiring.start();
    expect(setIntervalFn.mock.calls.length).toBeGreaterThanOrEqual(2);

    wiring.stop();
    expect(clearIntervalFn.mock.calls.length).toBe(setIntervalFn.mock.calls.length);
  });
});
