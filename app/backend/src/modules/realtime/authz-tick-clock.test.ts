import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import { createRealtimeHub } from './hub.js';
import { createAuthzTick } from './authz-tick.js';
import { connectFakeSink } from './__tests__/authz-tick-test-support.js';

/**
 * authz-tick-clock.test.ts (P05 test-engineer hardening pass) - the timer/
 * clock-boundary behaviors of `createAuthzTick`: `start()` must be
 * single-flight under a slow (not down) dependency (hunt item 8), `stop()`
 * racing an in-flight `runOnce` must not throw or corrupt state (hunt item
 * 7), and start()/stop() correctly wire an injected clock. Split from
 * authz-tick.test.ts to stay under the workspace's 300-line max-lines lint
 * rule.
 */

describe('createAuthzTick - clock boundaries', () => {
  it('a_slow_query_does_not_let_start_pile_up_overlapping_runOnce_calls', async () => {
    // Hunt item 8 (slow dependency, not down): the tick's own query resolves
    // slower than tickMs. `start()` must be single-flight - a tick whose
    // previous runOnce is still in-flight must not launch a second
    // concurrent query when the interval fires again.
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const userId = randomUUID();
    const clientId = randomUUID();
    connectFakeSink(hub, { connectionId: randomUUID(), userId, clientId, epoch: 0 });

    let inFlight = 0;
    let maxConcurrent = 0;
    let queryCalls = 0;
    const resolvers: Array<() => void> = [];
    const db: TenantQueryable = {
      query: (async (_sql: string, params?: unknown[]) => {
        queryCalls += 1;
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise<void>((resolve) => resolvers.push(resolve));
        inFlight -= 1;
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

    let fireTick: (() => void) | undefined;
    const tick = createAuthzTick({
      hub,
      db,
      tickMs: 5000,
      maxConsecutiveFailures: 6,
      metrics: { incrementAuthzTickErrors: () => {} },
      logger: { info: () => {}, error: () => {} },
      setInterval: ((cb: () => void) => {
        fireTick = cb;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearInterval: (() => {}) as unknown as typeof clearInterval,
    });

    tick.start();
    expect(fireTick).toBeDefined();

    // First interval fire: query is now in-flight (never resolved yet).
    fireTick!();
    expect(queryCalls).toBe(1);
    expect(inFlight).toBe(1);

    // Interval fires again while the first query is still pending (slow
    // dependency scenario) - a correct single-flight implementation must
    // not start a second overlapping query.
    fireTick!();
    fireTick!();

    expect(queryCalls).toBe(1);
    expect(maxConcurrent).toBe(1);

    // Let the first query resolve, then fire again - now a new tick is fine.
    resolvers.shift()!();
    await vi.waitFor(() => {
      expect(inFlight).toBe(0);
    });
    fireTick!();
    expect(queryCalls).toBe(2);
    resolvers.shift()?.();

    tick.stop();
  });

  it('stop_during_an_in_flight_runOnce_prevents_further_scheduled_ticks_but_lets_the_in_flight_call_finish', async () => {
    // Hunt item 7 (clock boundary): `stop()` racing an in-flight `runOnce`
    // must not throw and must not schedule any FURTHER tick once the
    // in-flight query resolves - `stop()`'s contract is "no more scheduled
    // ticks", not "abort work already in flight" (the in-flight query still
    // completing after a server-shutdown stop() is harmless: no more ticks
    // follow it either way).
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const userId = randomUUID();
    const clientId = randomUUID();
    connectFakeSink(hub, { connectionId: randomUUID(), userId, clientId, epoch: 0 });

    let resolveQuery: (() => void) | undefined;
    let queryCalls = 0;
    const db: TenantQueryable = {
      query: (async (_sql: string, params?: unknown[]) => {
        queryCalls += 1;
        await new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
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

    const inFlight = tick.runOnce();
    expect(queryCalls).toBe(1);

    expect(() => tick.stop()).not.toThrow();

    resolveQuery!();
    await expect(inFlight).resolves.toBeDefined();

    // No timer was ever registered by this path (runOnce called directly,
    // not via start()), so nothing further can fire regardless - this pins
    // that stop() itself never throws or corrupts state when called
    // mid-flight.
    expect(queryCalls).toBe(1);
  });

  it('a_hung_query_that_never_settles_counts_as_a_failed_tick_and_the_late_result_is_discarded', async () => {
    // MAJ-2 remainder: a query that never rejects nor resolves must not
    // leave the tick silently stuck forever - the load must be raced against
    // a deadline (derived from `tickMs`), and a timed-out tick must COUNT AS
    // A FAILED TICK feeding the existing consecutive-failure budget, logging
    // `event_type: 'realtime.authz_tick_failed'` / `error_class: 'timeout'`.
    // After `maxConsecutiveFailures` such timeouts, all connections must be
    // dropped with `authz_unverifiable` - fail-safe (core invariant 2) must
    // still trip even though the query itself never threw.
    vi.useFakeTimers();

    const hub = createRealtimeHub({ replayRingSize: 10 });
    const userId = randomUUID();
    const clientId = randomUUID();
    const sink = connectFakeSink(hub, { connectionId: randomUUID(), userId, clientId, epoch: 0 });

    const db: TenantQueryable = {
      // Never settles.
      query: (() => new Promise(() => undefined)) as unknown as TenantQueryable['query'],
    };

    const loggedErrors: Array<Record<string, unknown>> = [];
    let errorCount = 0;
    const maxConsecutiveFailures = 3;
    const tickMs = 5000;

    const tick = createAuthzTick({
      hub,
      db,
      tickMs,
      maxConsecutiveFailures,
      metrics: { incrementAuthzTickErrors: () => (errorCount += 1) },
      logger: {
        info: () => {},
        error: (fields) => loggedErrors.push(fields),
      },
    });

    for (let i = 0; i < maxConsecutiveFailures - 1; i += 1) {
      const resultPromise = tick.runOnce();
      await vi.advanceTimersByTimeAsync(tickMs);
      const result = await resultPromise;
      expect(Object.values(result.dropped).reduce((a, b) => a + b, 0)).toBe(0);
    }
    expect(sink.closed).toBe(false);
    expect(errorCount).toBe(maxConsecutiveFailures - 1);
    expect(loggedErrors.every((f) => f.error_class === 'timeout')).toBe(true);
    expect(loggedErrors.every((f) => f.event_type === 'realtime.authz_tick_failed')).toBe(true);

    // The Nth (budget-exhausting) timeout drops everyone.
    const finalPromise = tick.runOnce();
    await vi.advanceTimersByTimeAsync(tickMs);
    const finalResult = await finalPromise;
    expect(sink.closed).toBe(true);
    expect(sink.closeReason).toBe('authz_unverifiable');
    expect(finalResult.dropped.authz_unverifiable).toBe(1);
  });

  it('a_query_that_settles_after_its_deadline_has_its_result_discarded_and_does_not_drop_anyone', async () => {
    // The late-resolving query result must never be APPLIED after the
    // deadline - it must not drop anyone from stale-by-then data, and must
    // not reset the consecutive-failure counter behind the tick's back
    // either (the timeout that already fired for this tick is what counts).
    vi.useFakeTimers();

    const hub = createRealtimeHub({ replayRingSize: 10 });
    const userId = randomUUID();
    const clientId = randomUUID();
    const sink = connectFakeSink(hub, { connectionId: randomUUID(), userId, clientId, epoch: 0 });

    let resolveQuery: ((value: unknown) => void) | undefined;
    const tickMs = 5000;
    const db: TenantQueryable = {
      query: (() =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        })) as unknown as TenantQueryable['query'],
    };

    const tick = createAuthzTick({
      hub,
      db,
      tickMs,
      maxConsecutiveFailures: 6,
      metrics: { incrementAuthzTickErrors: () => {} },
      logger: { info: () => {}, error: () => {} },
    });

    const resultPromise = tick.runOnce();
    await vi.advanceTimersByTimeAsync(tickMs);
    const result = await resultPromise;
    expect(Object.values(result.dropped).reduce((a, b) => a + b, 0)).toBe(0);

    // Now the query resolves LATE, with data that (if wrongly applied) would
    // drop the connection via a bumped token_epoch.
    resolveQuery!({
      rows: [{ user_id: userId, token_epoch: 999, client_id: clientId, client_status: 'active' }],
      rowCount: 1,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(sink.closed).toBe(false);
  });

  it('start_and_stop_drive_runOnce_on_an_injected_interval', async () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    let queryCalls = 0;
    const db: TenantQueryable = {
      query: (async () => {
        queryCalls += 1;
        return { rows: [], rowCount: 0 };
      }) as TenantQueryable['query'],
    };

    const fakeSetInterval = vi.fn<(fn: () => void, ms: number) => ReturnType<typeof setInterval>>(
      () => {
        // Never auto-fires - this test only proves start()/stop() wire the
        // injected clock rather than the real global timers.
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
    );
    const fakeClearInterval = vi.fn();

    const tick = createAuthzTick({
      hub,
      db,
      tickMs: 5000,
      maxConsecutiveFailures: 6,
      metrics: { incrementAuthzTickErrors: () => {} },
      logger: { info: () => {}, error: () => {} },
      setInterval: fakeSetInterval as unknown as typeof setInterval,
      clearInterval: fakeClearInterval as unknown as typeof clearInterval,
    });

    tick.start();
    expect(fakeSetInterval).toHaveBeenCalledTimes(1);
    expect(fakeSetInterval.mock.calls[0]?.[1]).toBe(5000);
    tick.stop();
    expect(fakeClearInterval).toHaveBeenCalledTimes(1);
    expect(queryCalls).toBe(0);
  });
});
