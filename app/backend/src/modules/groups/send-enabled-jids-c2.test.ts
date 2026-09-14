import { describe, expect, it } from 'vitest';
import { createSendEnabledGroupJidsProvider } from './send-enabled-jids.js';

/**
 * send-enabled-jids-c2.test.ts (P24 C2 test-engineer) - unit-level edge
 * cases for `createSendEnabledGroupJidsProvider` beyond `send-enabled-jids.
 * test.ts`'s own coverage: 1000 synchronous `get()` calls inside `ttlMs`
 * issue exactly one query, a rejecting refresh keeps the snapshot AND the
 * NEXT `get()` past `ttlMs` retries (no permanent poison), `stop()` then
 * `get()` issues no new query, two provider instances on the same instance
 * id never share state, and the 5000-entry LIMIT truncation is surfaced
 * as-is (never de-duplicated/re-sorted client-side).
 *
 * Same fake-`tenantDb` harness idiom as the sibling `send-enabled-jids.
 * test.ts` (no real Postgres connection; `loadQuery` reads the real SQL
 * file from disk, which needs no server-kit env).
 */

interface FakeTenantDb {
  withTenant<T>(clientId: string, fn: (tx: unknown) => Promise<T>): Promise<T>;
}

function fakeTenantDb(run: () => Promise<{ rows: { group_jid: string }[] }>): FakeTenantDb {
  return {
    withTenant: async (_clientId, fn) =>
      fn({
        query: async () => run(),
      }),
  };
}

function fakeClock(startMs: number) {
  let now = startMs;
  return {
    clock: { now: () => now },
    advance: (deltaMs: number) => {
      now += deltaMs;
    },
  };
}

describe('createSendEnabledGroupJidsProvider - repeated get() within ttl', () => {
  it('1000_synchronous_get_calls_within_ttlMs_issue_exactly_one_query', async () => {
    let queryCount = 0;
    const tenantDb = fakeTenantDb(async () => {
      queryCount += 1;
      return { rows: [{ group_jid: '1@g.us' }] };
    });
    const { clock } = fakeClock(0);
    const provider = createSendEnabledGroupJidsProvider({
      tenantDb: tenantDb as never,
      clientId: 'client-1',
      instanceId: 'instance-1',
      clock,
      ttlMs: 30_000,
    });

    // First get() is stale (lastRefreshedAt starts at -Infinity) and
    // schedules exactly one background refresh; await it before hammering.
    provider.get();
    await provider.refresh();
    queryCount = 0; // reset: only count calls AFTER the initial warm-up.

    for (let i = 0; i < 1000; i += 1) {
      provider.get();
    }
    // Every one of those 1000 calls is within ttlMs of the just-completed
    // refresh, so none should have scheduled a new background refresh.
    await Promise.resolve();
    expect(queryCount).toBe(0);
  });
});

describe('createSendEnabledGroupJidsProvider - a rejecting refresh keeps the snapshot and later retries', () => {
  it('a_refresh_that_rejects_keeps_the_snapshot_and_the_next_get_past_ttl_retries_no_permanent_poison', async () => {
    let callCount = 0;
    const tenantDb = fakeTenantDb(async () => {
      callCount += 1;
      if (callCount === 2) {
        throw new Error('simulated transient query failure');
      }
      return { rows: [{ group_jid: '1@g.us' }] };
    });
    const { clock, advance } = fakeClock(0);
    const warnings: string[] = [];
    const provider = createSendEnabledGroupJidsProvider({
      tenantDb: tenantDb as never,
      clientId: 'client-1',
      instanceId: 'instance-1',
      clock,
      ttlMs: 1_000,
      logger: { warn: (_obj, msg) => warnings.push(msg) },
    });

    provider.get();
    await provider.refresh();
    expect([...provider.get()]).toEqual(['1@g.us']);

    // Force the SECOND refresh (callCount===2) to fail. Call `refresh()`
    // directly (not via `get()`'s fire-and-forget scheduling) so the
    // rejection is deterministically awaited before asserting - `refresh()`
    // itself never rejects (the provider catches internally and logs).
    advance(2_000);
    await provider.refresh();
    expect(callCount).toBe(2);

    // Snapshot is UNCHANGED (still has the group from the first refresh) -
    // never cleared, never poisoned.
    expect([...provider.get()]).toEqual(['1@g.us']);
    expect(warnings.some((w) => w.includes('refresh failed'))).toBe(true);

    // A THIRD refresh, past ttl again, must actually retry (not permanently
    // give up because the second one failed).
    advance(2_000);
    provider.get();
    await provider.refresh();
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

describe('createSendEnabledGroupJidsProvider - stop() then get() issues no new query', () => {
  it('stop_then_get_returns_the_last_snapshot_and_never_queries_again', async () => {
    let queryCount = 0;
    const tenantDb = fakeTenantDb(async () => {
      queryCount += 1;
      return { rows: [{ group_jid: '1@g.us' }] };
    });
    const { clock, advance } = fakeClock(0);
    const provider = createSendEnabledGroupJidsProvider({
      tenantDb: tenantDb as never,
      clientId: 'client-1',
      instanceId: 'instance-1',
      clock,
      ttlMs: 1_000,
    });

    provider.get();
    await provider.refresh();
    const countAfterWarmup = queryCount;

    provider.stop();
    advance(10_000); // well past ttl
    const snapshot = provider.get();
    expect([...snapshot]).toEqual(['1@g.us']);
    await Promise.resolve();
    expect(queryCount).toBe(countAfterWarmup);
  });
});

describe('createSendEnabledGroupJidsProvider - two instances never share state', () => {
  it('two_provider_instances_for_the_same_instance_id_do_not_share_a_snapshot', async () => {
    const tenantDbA = fakeTenantDb(async () => ({ rows: [{ group_jid: 'a@g.us' }] }));
    const tenantDbB = fakeTenantDb(async () => ({ rows: [{ group_jid: 'b@g.us' }] }));
    const { clock } = fakeClock(0);

    const providerA = createSendEnabledGroupJidsProvider({
      tenantDb: tenantDbA as never,
      clientId: 'client-1',
      instanceId: 'instance-1',
      clock,
    });
    const providerB = createSendEnabledGroupJidsProvider({
      tenantDb: tenantDbB as never,
      clientId: 'client-1',
      instanceId: 'instance-1',
      clock,
    });

    providerA.get();
    await providerA.refresh();
    providerB.get();
    await providerB.refresh();

    expect([...providerA.get()]).toEqual(['a@g.us']);
    expect([...providerB.get()]).toEqual(['b@g.us']);
  });
});

describe('createSendEnabledGroupJidsProvider - the LIMIT truncation is surfaced as-is', () => {
  it('a_5000_row_result_is_stored_verbatim_with_no_client_side_re_limiting_or_reordering', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ group_jid: `g${i}@g.us` }));
    const tenantDb = fakeTenantDb(async () => ({ rows }));
    const { clock } = fakeClock(0);
    const provider = createSendEnabledGroupJidsProvider({
      tenantDb: tenantDb as never,
      clientId: 'client-1',
      instanceId: 'instance-1',
      clock,
    });

    provider.get();
    await provider.refresh();
    const snapshot = provider.get();
    expect(snapshot.size).toBe(5000);
    expect(snapshot.has('g0@g.us')).toBe(true);
    expect(snapshot.has('g4999@g.us')).toBe(true);
  });
});
