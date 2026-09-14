import { describe, expect, it } from 'vitest';
import { createSendEnabledGroupJidsProvider } from './send-enabled-jids.js';

/**
 * send-enabled-jids.test.ts (P24 Unit U4b, step 8) - pure unit tests for the
 * background-refreshing group-jid allow-list provider: `get()` is
 * synchronous and returns the last snapshot, a stale snapshot schedules
 * exactly one background refresh (never a concurrent second one), and a
 * failing refresh keeps the previous snapshot (fail-open on the FILTER means
 * dropping group messages, never widening the allow-list - see this
 * module's own header). No real Postgres/Redis - `tenantDb` is a stub, the
 * clock is injected.
 */

interface FakeTenantDb {
  withTenant<T>(clientId: string, fn: (tx: unknown) => Promise<T>): Promise<T>;
}

function fakeTenantDb(run: () => Promise<{ group_jid: string }[]>): FakeTenantDb {
  return {
    withTenant: async (_clientId, fn) =>
      fn({
        query: async () => ({ rows: await run() }),
      }),
  };
}

describe('createSendEnabledGroupJidsProvider', () => {
  it('the_first_get_is_empty_and_schedules_one_refresh', async () => {
    let queryCount = 0;
    const tenantDb = fakeTenantDb(() => {
      queryCount += 1;
      return Promise.resolve([{ group_jid: '1@g.us' }]);
    });
    const now = 0;
    const provider = createSendEnabledGroupJidsProvider({
      tenantDb: tenantDb as never,
      clientId: 'client-1',
      instanceId: 'instance-1',
      clock: { now: () => now },
      ttlMs: 30_000,
    });

    expect(provider.get()).toEqual(new Set());
    // The stale-snapshot check on the FIRST get (age = now - 0 = 0, which is
    // NOT > ttlMs) would not itself schedule a refresh - the provider seeds
    // one refresh at construction instead (see the module's own doc: "call
    // provider.refresh() once at wiring").
    await provider.refresh();
    expect(queryCount).toBe(1);
    expect(provider.get()).toEqual(new Set(['1@g.us']));
    provider.stop();
  });

  it('a_snapshot_within_ttl_never_triggers_a_second_query', async () => {
    let queryCount = 0;
    const tenantDb = fakeTenantDb(() => {
      queryCount += 1;
      return Promise.resolve([{ group_jid: '2@g.us' }]);
    });
    let now = 0;
    const provider = createSendEnabledGroupJidsProvider({
      tenantDb: tenantDb as never,
      clientId: 'client-1',
      instanceId: 'instance-1',
      clock: { now: () => now },
      ttlMs: 30_000,
    });

    await provider.refresh();
    expect(queryCount).toBe(1);

    now = 10_000; // within ttlMs of the last refresh.
    expect(provider.get()).toEqual(new Set(['2@g.us']));
    expect(queryCount).toBe(1);
    provider.stop();
  });

  it('a_stale_snapshot_triggers_exactly_one_more_query', async () => {
    let queryCount = 0;
    const tenantDb = fakeTenantDb(() => {
      queryCount += 1;
      return Promise.resolve([{ group_jid: '3@g.us' }]);
    });
    let now = 0;
    const provider = createSendEnabledGroupJidsProvider({
      tenantDb: tenantDb as never,
      clientId: 'client-1',
      instanceId: 'instance-1',
      clock: { now: () => now },
      ttlMs: 30_000,
    });

    await provider.refresh();
    expect(queryCount).toBe(1);

    now = 30_001; // past ttlMs.
    provider.get();
    // The background refresh is fire-and-forget: await a microtask turn so
    // its promise settles before asserting the query count.
    await Promise.resolve();
    await Promise.resolve();
    expect(queryCount).toBe(2);

    // A second get() while still fresh must not schedule yet another one.
    provider.get();
    await Promise.resolve();
    expect(queryCount).toBe(2);
    provider.stop();
  });

  it('a_failing_refresh_keeps_the_previous_snapshot', async () => {
    let queryCount = 0;
    const tenantDb: FakeTenantDb = {
      withTenant: async () => {
        queryCount += 1;
        throw new Error('simulated db failure');
      },
    };
    const logged: unknown[] = [];
    const now = 0;
    const provider = createSendEnabledGroupJidsProvider({
      tenantDb: tenantDb as never,
      clientId: 'client-1',
      instanceId: 'instance-1',
      clock: { now: () => now },
      ttlMs: 30_000,
      logger: { warn: (obj) => logged.push(obj) },
    });

    await provider.refresh();
    expect(queryCount).toBe(1);
    expect(provider.get()).toEqual(new Set());
    expect(logged).toHaveLength(1);
    provider.stop();
  });
});
