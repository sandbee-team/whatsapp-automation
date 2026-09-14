import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createContactImportCronLoop } from './cron-wiring-contacts.js';

/**
 * cron-wiring-contacts.test.ts (P20 Unit U5, step 6) - unit-level proof of
 * `createContactImportCronLoop`'s composition: one tick calls the sweep
 * once through the single-flight lock, and a `db_error` outcome backs off
 * (same fake-timer idiom as `cron-wiring-wallet.test.ts`).
 */

function makeFakePool(
  lockAcquired: boolean,
  sweepRows: unknown[] = [],
): {
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
} {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return { rows: [{ pg_try_advisory_xact_lock: lockAcquired }] };
      }
      return { rows: sweepRows };
    }),
    release: vi.fn(),
  };
  return {
    query: vi.fn(async () => ({ rows: sweepRows })),
    connect: vi.fn(async () => client),
  };
}

function makeFakeTenantDb(): { withTenant: ReturnType<typeof vi.fn> } {
  return { withTenant: vi.fn(async () => undefined) };
}

describe('createContactImportCronLoop', () => {
  it('one_tick_calls_the_sweep_once_via_the_single_flight_lock', async () => {
    const setIntervalFn = vi.fn().mockReturnValue(1 as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();
    const pool = makeFakePool(true, []);
    const tenantDb = makeFakeTenantDb();
    const metrics = {
      contactsImportedTotal: { inc: vi.fn() },
      contactImportRowsTotal: { inc: vi.fn() },
      optoutMirrorDriftTotal: { inc: vi.fn() },
    } as never;

    const loop = createContactImportCronLoop({
      pool: pool as never,
      tenantDb: tenantDb as never,
      keyProvider: {} as never,
      objectStore: {} as never,
      metrics,
      setIntervalFn,
      clearIntervalFn,
      logOutcome: () => undefined,
    });

    loop.start();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn.mock.calls[0]?.[1]).toBeCloseTo(2_000, 0);

    const onTick = setIntervalFn.mock.calls[0]?.[0] as () => void;
    onTick();
    // Let the microtask queue drain so the async runOne() resolves.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  it('a_db_error_outcome_backs_off_the_interval', async () => {
    const setIntervalFn = vi.fn().mockReturnValue(1 as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();
    const failingPool = {
      connect: vi.fn().mockRejectedValue(new Error('connect failed')),
      query: vi.fn(),
    };
    const tenantDb = makeFakeTenantDb();
    const metrics = {
      contactsImportedTotal: { inc: vi.fn() },
      contactImportRowsTotal: { inc: vi.fn() },
      optoutMirrorDriftTotal: { inc: vi.fn() },
    } as never;
    const outcomes: string[] = [];

    const loop = createContactImportCronLoop({
      pool: failingPool as never,
      tenantDb: tenantDb as never,
      keyProvider: {} as never,
      objectStore: {} as never,
      metrics,
      setIntervalFn,
      clearIntervalFn,
      logOutcome: (_name, outcome) => outcomes.push(outcome),
    });

    loop.start();
    const onTick = setIntervalFn.mock.calls[0]?.[0] as () => void;
    onTick();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(outcomes).toEqual(['db_error']);
    // A backoff-triggered re-arm calls setIntervalFn a second time with a longer interval.
    expect(setIntervalFn).toHaveBeenCalledTimes(2);
    expect(setIntervalFn.mock.calls[1]?.[1]).toBeGreaterThan(2_000);
  });

  it('a_db_error_outcome_passes_the_real_error_through_to_logOutcome_never_undefined', async () => {
    const setIntervalFn = vi.fn().mockReturnValue(1 as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();
    const thrownError = new Error('connect failed');
    const failingPool = {
      connect: vi.fn().mockRejectedValue(thrownError),
      query: vi.fn(),
    };
    const tenantDb = makeFakeTenantDb();
    const metrics = {
      contactsImportedTotal: { inc: vi.fn() },
      contactImportRowsTotal: { inc: vi.fn() },
      optoutMirrorDriftTotal: { inc: vi.fn() },
    } as never;
    const loggedErrors: unknown[] = [];

    const loop = createContactImportCronLoop({
      pool: failingPool as never,
      tenantDb: tenantDb as never,
      keyProvider: {} as never,
      objectStore: {} as never,
      metrics,
      setIntervalFn,
      clearIntervalFn,
      logOutcome: (_name, _outcome, error) => loggedErrors.push(error),
    });

    loop.start();
    const onTick = setIntervalFn.mock.calls[0]?.[0] as () => void;
    onTick();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(loggedErrors).toEqual([thrownError]);
  });
});
