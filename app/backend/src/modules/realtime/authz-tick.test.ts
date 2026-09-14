import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import { createRealtimeHub } from './hub.js';
import { createAuthzTick } from './authz-tick.js';
import { connectFakeSink } from './__tests__/authz-tick-test-support.js';

/**
 * authz-tick.test.ts (P05 Unit U3b) - unit-level proof of `createAuthzTick`
 * against a fake `db.query` and the REAL hub (fake in-memory sinks, no HTTP):
 * exactly one query per tick regardless of connection count, the fail-safe
 * consecutive-failure budget, and per-user-only drops. See
 * authz-tick-clock.test.ts for start()/stop()/single-flight timer behavior
 * (split to stay under the workspace's 300-line max-lines lint rule).
 */

describe('createAuthzTick', () => {
  it('the_authz_tick_issues_one_query_per_tick_not_one_per_connection', async () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const users = Array.from({ length: 40 }, () => randomUUID());
    const clientId = randomUUID();

    for (const userId of users) {
      for (let i = 0; i < 5; i += 1) {
        connectFakeSink(hub, { connectionId: randomUUID(), userId, clientId, epoch: 0 });
      }
    }
    expect(hub.connectionCount()).toBe(200);

    let queryCalls = 0;
    const db: TenantQueryable = {
      query: (async (_sql: string, params?: unknown[]) => {
        queryCalls += 1;
        const userIds = (params?.[0] as readonly string[] | undefined) ?? [];
        return {
          rows: userIds.map((userId) => ({
            user_id: userId,
            token_epoch: 0,
            client_id: clientId,
            client_status: 'active',
          })),
          rowCount: userIds.length,
        };
      }) as TenantQueryable['query'],
    };

    const tick = createAuthzTick({
      hub,
      db,
      tickMs: 5000,
      maxConsecutiveFailures: 6,
      metrics: { incrementAuthzTickErrors: () => {} },
      logger: { info: () => {}, error: () => {} },
    });

    const result = await tick.runOnce();
    expect(queryCalls).toBe(1);
    expect(result.queries).toBe(1);
    expect(result.usersChecked).toBe(40);

    // A second tick with the SAME set of connections still issues exactly
    // one more query, not 200.
    await tick.runOnce();
    expect(queryCalls).toBe(2);
  });

  it('the_authz_tick_issues_zero_queries_when_no_connections_exist', async () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    let queryCalls = 0;
    const db: TenantQueryable = {
      query: (async () => {
        queryCalls += 1;
        return { rows: [], rowCount: 0 };
      }) as TenantQueryable['query'],
    };

    const tick = createAuthzTick({
      hub,
      db,
      tickMs: 5000,
      maxConsecutiveFailures: 6,
      metrics: { incrementAuthzTickErrors: () => {} },
      logger: { info: () => {}, error: () => {} },
    });

    const result = await tick.runOnce();
    expect(queryCalls).toBe(0);
    expect(result.queries).toBe(0);
    expect(result.usersChecked).toBe(0);
  });

  it('the_user_set_becoming_empty_between_ticks_stops_querying_on_the_next_tick', async () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const userId = randomUUID();
    const clientId = randomUUID();
    const connectionId = randomUUID();

    let queryCalls = 0;
    const db: TenantQueryable = {
      query: (async (_sql: string, params?: unknown[]) => {
        queryCalls += 1;
        const userIds = (params?.[0] as readonly string[] | undefined) ?? [];
        return {
          rows: userIds.map((id) => ({
            user_id: id,
            token_epoch: 0,
            client_id: clientId,
            client_status: 'active',
          })),
          rowCount: userIds.length,
        };
      }) as TenantQueryable['query'],
    };

    const tick = createAuthzTick({
      hub,
      db,
      tickMs: 5000,
      maxConsecutiveFailures: 6,
      metrics: { incrementAuthzTickErrors: () => {} },
      logger: { info: () => {}, error: () => {} },
    });

    // Tick 1: one connected user -> exactly one query.
    connectFakeSink(hub, { connectionId, userId, clientId, epoch: 0 });
    const first = await tick.runOnce();
    expect(queryCalls).toBe(1);
    expect(first.queries).toBe(1);

    // The connection drops entirely between ticks (e.g. client navigated
    // away) - the hub now has zero live connections.
    hub.disconnect(connectionId, 'client_disconnect');
    expect(hub.connectionCount()).toBe(0);

    // Tick 2: the empty-user-set fast path must apply - no query issued.
    const second = await tick.runOnce();
    expect(queryCalls).toBe(1);
    expect(second.queries).toBe(0);
    expect(second.usersChecked).toBe(0);
  });

  it('a_failing_tick_keeps_connections_until_the_failure_budget_is_exhausted', async () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const userId = randomUUID();
    const clientId = randomUUID();
    const sink = connectFakeSink(hub, { connectionId: randomUUID(), userId, clientId, epoch: 0 });

    const db: TenantQueryable = {
      query: (async () => {
        throw new Error('postgres is down');
      }) as TenantQueryable['query'],
    };

    let errorCount = 0;
    const tick = createAuthzTick({
      hub,
      db,
      tickMs: 5000,
      maxConsecutiveFailures: 6,
      metrics: { incrementAuthzTickErrors: () => (errorCount += 1) },
      logger: { info: () => {}, error: () => {} },
    });

    for (let i = 0; i < 5; i += 1) {
      const result = await tick.runOnce();
      expect(Object.values(result.dropped).reduce((a, b) => a + b, 0)).toBe(0);
    }
    expect(sink.closed).toBe(false);
    expect(errorCount).toBe(5);

    // 6th consecutive failure exhausts the budget - drop everyone.
    const sixthResult = await tick.runOnce();
    expect(sink.closed).toBe(true);
    expect(sink.closeReason).toBe('authz_unverifiable');
    expect(sixthResult.dropped.authz_unverifiable).toBe(1);
    expect(errorCount).toBe(6);
  });

  it('a_tick_drops_only_the_affected_user', async () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const clientId = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();

    const sinkA = connectFakeSink(hub, {
      connectionId: randomUUID(),
      userId: userA,
      clientId,
      epoch: 0,
    });
    const sinkB = connectFakeSink(hub, {
      connectionId: randomUUID(),
      userId: userB,
      clientId,
      epoch: 0,
    });

    // userA's epoch bumped to 1 server-side; userB unchanged.
    const db: TenantQueryable = {
      query: (async (_sql: string, params?: unknown[]) => {
        const userIds = (params?.[0] as readonly string[] | undefined) ?? [];
        return {
          rows: userIds.map((id) => ({
            user_id: id,
            token_epoch: id === userA ? 1 : 0,
            client_id: clientId,
            client_status: 'active',
          })),
          rowCount: userIds.length,
        };
      }) as TenantQueryable['query'],
    };

    const tick = createAuthzTick({
      hub,
      db,
      tickMs: 5000,
      maxConsecutiveFailures: 6,
      metrics: { incrementAuthzTickErrors: () => {} },
      logger: { info: () => {}, error: () => {} },
    });

    const result = await tick.runOnce();
    expect(sinkA.closed).toBe(true);
    expect(sinkA.closeReason).toBe('token_epoch');
    expect(sinkB.closed).toBe(false);
    expect(result.dropped.token_epoch).toBe(1);
  });
});
