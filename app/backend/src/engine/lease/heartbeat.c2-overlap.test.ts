import { describe, expect, it, vi } from 'vitest';
import type { WorkerDb } from '@wp/db';
import { TIMING } from '@wp/domain';
import { LeaseHeartbeat } from './heartbeat.js';
import type { LeaseRedis } from './lease-redis.js';
import type { LeaseQueryable } from './lease-state-repo.js';
import {
  COMPRESSED_TIMING,
  stubWorkerDb,
  deferredCalled,
  makeLease,
  makeSessionOwner,
} from './heartbeat-c2-test-support.js';

/**
 * heartbeat.c2-overlap.test.ts (P06 C2 all-cases pass, FIX-P09-B split) -
 * probe 3, split out of `heartbeat.c2.test.ts` at FIX-P09-B for the
 * max-lines cap (topic split only - same cases, unchanged). Not covered by
 * heartbeat.edge.test.ts / heartbeat.integration.test.ts / watchdog.test.ts:
 *
 *   3. Heartbeat tick overlap / re-entrancy: a tick whose Redis/PG call is
 *      SLOW (resolves after heartbeatMs has elapsed) while a second `tick()`
 *      is invoked (as `start()`'s `setInterval` would do) before the first
 *      resolves.
 *
 * No real Redis/Postgres, no real timers - Redis/PG calls are manually
 * controlled deferred promises; `monotonicNow` is a fully injected counter.
 */

describe('probe 3: heartbeat tick overlap / re-entrancy', () => {
  it('a_second_tick_fired_while_the_first_is_still_awaiting_a_slow_pg_renew_is_SKIPPED_not_run_and_increments_the_skip_counter', async () => {
    // FIX-1 (C1 WARNING 6 / C2 REAL FINDING 1): a tick already in flight
    // must SKIP a second concurrent tick() call rather than starting an
    // overlapping runTick() - no second renewBatch statement, no
    // retry-storm shape. The skip is counted via metrics.incrementTicksSkipped.
    const lease = makeLease('inst-overlap');
    const sessionOwner = makeSessionOwner();

    // lease-state-repo.ts's renewBatch runs the renew statement inside
    // `withWorker`'s pinned transaction (the GUC set happens on that same
    // real connection, never as a separate `sql.query` call in this stub's
    // world - `stubWorkerDb` hands `fn` the queryable directly with no real
    // transaction). Only the renew statement itself is held pending here.
    let renewCallCount = 0;
    const renewResolvers: Array<(value: { rows: Array<{ instance_id: string }> }) => void> = [];
    const pgQueryCalled = deferredCalled();
    const pgQuery = vi.fn(() => {
      renewCallCount += 1;
      pgQueryCalled.resolve();
      return new Promise((resolve) => {
        renewResolvers.push(resolve as (value: { rows: Array<{ instance_id: string }> }) => void);
      });
    });
    const pgSql: WorkerDb = stubWorkerDb({ query: pgQuery as unknown as LeaseQueryable['query'] });

    const leaseRedis: LeaseRedis = {
      acquire: vi.fn(),
      setFence: vi.fn(),
      // Redis resolves quickly and successfully every time - isolates this
      // probe to the PG leg overlapping.
      renewBatch: vi.fn().mockResolvedValue([true]),
      release: vi.fn(),
    };

    const incrementTicksSkipped = vi.fn();
    const heartbeat = new LeaseHeartbeat({
      leaseRedis,
      pgSql,
      sessionOwner,
      workerId: 'worker-1',
      env: 'test',
      timing: COMPRESSED_TIMING as unknown as typeof TIMING,
      monotonicNow: () => 0n,
      metrics: { incrementLeaseLost: vi.fn(), incrementTicksSkipped },
    });
    heartbeat.add(lease);

    // Fire tick #1. `runTick` awaits the Redis leg (a resolved promise)
    // before reaching the PG call; wait for the deterministic "PG stub was
    // actually invoked" signal below rather than counting turns.
    const tick1 = heartbeat.tick();
    // Deterministic: wait for the PG stub to actually be invoked (not a
    // fixed number of microtask/macrotask turns - see `deferredCalled`'s
    // doc for why turn counting is unsafe here).
    await pgQueryCalled.promise;
    expect(renewCallCount).toBe(1);

    // Simulate the setInterval firing again before tick #1's PG renew has
    // resolved (a slow-not-down PG round trip that outlives heartbeatMs).
    // `tick()`'s skip branch (an in-flight tick already exists) runs
    // entirely synchronously up to and including
    // `metrics.incrementTicksSkipped()` - `async function` only defers the
    // RETURN value, not execution before the first `await` - so no flush of
    // any kind is needed before asserting on it.
    const tick2 = heartbeat.tick();

    // FIXED BEHAVIOR: the second tick is SKIPPED - no second renewBatch
    // statement is issued while the first is still in flight, and the skip
    // is counted.
    expect(renewCallCount).toBe(1);
    expect(incrementTicksSkipped).toHaveBeenCalledTimes(1);

    // Resolve the one in-flight renew call, then confirm both tick()
    // promises settle without crashing and without any state corruption.
    renewResolvers[0]?.({ rows: [{ instance_id: 'inst-overlap' }] });
    await Promise.all([tick1, tick2]);

    expect(sessionOwner.onFenceLost).not.toHaveBeenCalled();
    expect(heartbeat.held().map((l) => l.instanceId)).toEqual(['inst-overlap']);
  });

  it('stop_awaits_every_in_flight_tick_not_just_the_latest_even_though_overlapping_ticks_are_now_skipped', async () => {
    // With overlap now skipped, only ONE runTick can ever be in flight at a
    // time - but stop() must still correctly await it (tracking ALL
    // in-flight ticks, not just "the newest", per the fix spec) so that a
    // slow tick can never race past stop().
    const lease = makeLease('inst-track');
    const sessionOwner = makeSessionOwner();

    let resolveFirst: (() => void) | undefined;
    const pgQueryCalled = deferredCalled();
    const pgQuery = vi.fn(() => {
      return new Promise((resolve) => {
        resolveFirst = () => resolve({ rows: [{ instance_id: 'inst-track' }] });
        pgQueryCalled.resolve();
      });
    });
    const pgSql: WorkerDb = stubWorkerDb({ query: pgQuery as unknown as LeaseQueryable['query'] });

    const leaseRedis: LeaseRedis = {
      acquire: vi.fn(),
      setFence: vi.fn(),
      renewBatch: vi.fn().mockResolvedValue([true]),
      release: vi.fn(),
    };

    const incrementTicksSkipped = vi.fn();
    const heartbeat = new LeaseHeartbeat({
      leaseRedis,
      pgSql,
      sessionOwner,
      workerId: 'worker-1',
      env: 'test',
      timing: COMPRESSED_TIMING as unknown as typeof TIMING,
      monotonicNow: () => 0n,
      metrics: { incrementLeaseLost: vi.fn(), incrementTicksSkipped },
    });
    heartbeat.add(lease);

    const tick1 = heartbeat.tick();
    // Deterministic: wait for the PG stub to actually be invoked before
    // firing the second tick, instead of counting a fixed number of turns
    // (see `deferredCalled`'s doc).
    await pgQueryCalled.promise;

    // A second tick fired while tick1 is still in flight - it must be
    // skipped (no overlapping runTick), and the skip counter increments.
    // The skip branch runs synchronously (see the sibling test's comment),
    // so no flush is needed before asserting on it.
    const tick2 = heartbeat.tick();
    expect(incrementTicksSkipped).toHaveBeenCalledTimes(1);

    let stopResolved = false;
    const stopPromise = heartbeat.stop().then(() => {
      stopResolved = true;
    });

    // stop() must NOT resolve while tick1 is still pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    // Resolve the one real in-flight PG call; stop() may now resolve.
    resolveFirst?.();
    await tick1;
    await tick2;
    await stopPromise;
    expect(stopResolved).toBe(true);
  });
});
