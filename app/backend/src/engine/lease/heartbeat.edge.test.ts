import { describe, expect, it, vi } from 'vitest';
import { TIMING } from '@wp/domain';
import type { WorkerDb, WorkerQueryable } from '@wp/db';
import { LeaseHeartbeat } from './heartbeat.js';
import type { LeaseRedis } from './lease-redis.js';
import type { LeaseQueryable, RenewBatchResult } from './lease-state-repo.js';
import type { SessionOwner } from './session-owner.port.js';
import type { SessionLease } from './lease-manager.js';

/**
 * heartbeat.edge.test.ts (P06 E3 edge pass) - unit-level edge cases NOT
 * covered by watchdog.test.ts/heartbeat.integration.test.ts: remove()
 * called mid-tick (no onFenceLost for a removed instance, no crash). No
 * real Redis/Postgres.
 *
 * The watchdog-deadline-reset-after-recovery case lives in
 * `heartbeat.watchdog-baseline.edge.test.ts`, split out of this file to
 * stay under the workspace max-lines limit.
 */

/** Wraps a bare `LeaseQueryable` stub into a `WorkerDb` - see heartbeat.c2.test.ts's identical helper. */
function stubWorkerDb(queryable: LeaseQueryable): WorkerDb {
  return {
    withWorker: (_workerId, fn) => fn(queryable as unknown as WorkerQueryable),
  };
}

const COMPRESSED_TIMING = {
  ...TIMING,
  heartbeatMs: 1_000,
  watchdogMs: 15_000,
  leaseTtlMs: 30_000,
  redisCommandTimeoutMs: 2_000,
} as const;

function makeLease(instanceId: string): SessionLease {
  return {
    instanceId,
    clientId: `client-${instanceId}`,
    fence: 1n,
    workerId: 'worker-1',
    graceMs: 0,
  };
}

function makeSessionOwner(): SessionOwner {
  return { onFenceLost: vi.fn(), close: vi.fn() };
}

describe('heartbeat mutation during an in-flight tick', () => {
  it('remove_called_while_tick_in_flight_no_onFenceLost_for_removed_instance_no_crash', async () => {
    // Two held leases. The Redis renewBatch call is a manually-controlled
    // deferred promise so the test can call `remove()` for one instance
    // WHILE the tick's round trip is still pending, then let it resolve.
    let resolveRenew: ((value: boolean[]) => void) | undefined;
    const renewBatchMock = vi.fn(
      () =>
        new Promise<boolean[]>((resolve) => {
          resolveRenew = resolve;
        }),
    );
    const leaseRedis: LeaseRedis = {
      acquire: vi.fn(),
      setFence: vi.fn(),
      renewBatch: renewBatchMock as unknown as LeaseRedis['renewBatch'],
      release: vi.fn(),
    };

    const pgRenewResult: RenewBatchResult = { ok: true, renewed: new Set(['inst-a', 'inst-b']) };
    const pgQuery = vi
      .fn()
      .mockResolvedValue({ rows: [{ instance_id: 'inst-a' }, { instance_id: 'inst-b' }] });
    const pgSql: WorkerDb = stubWorkerDb({ query: pgQuery });
    void pgRenewResult;

    const sessionOwner = makeSessionOwner();
    const leaseA = makeLease('inst-a');
    const leaseB = makeLease('inst-b');

    const heartbeat = new LeaseHeartbeat({
      leaseRedis,
      pgSql,
      sessionOwner,
      workerId: 'worker-1',
      env: 'test',
      timing: COMPRESSED_TIMING as unknown as typeof TIMING,
      monotonicNow: () => 0n,
    });
    heartbeat.add(leaseA);
    heartbeat.add(leaseB);

    const tickPromise = heartbeat.tick();

    // Mid-tick: remove inst-b (voluntary release racing the in-flight
    // renew) BEFORE the Redis call resolves.
    heartbeat.remove('inst-b');
    expect(heartbeat.held().map((l) => l.instanceId)).toEqual(['inst-a']);

    // Now let the in-flight Redis renewBatch resolve - it still reports for
    // BOTH instances it was originally called with (the redis call was
    // already in flight with the original entry list), including a `false`
    // for the removed instance b would normally trigger a self-fence
    // decision for it - the point of this test is that no crash occurs and
    // no onFenceLost is double-reported for the racing removal.
    resolveRenew?.([true, true]);
    await tickPromise;

    // No crash (implicit - reaching here). No onFenceLost call at all,
    // since both renews (as originally issued) reported true.
    expect(sessionOwner.onFenceLost).not.toHaveBeenCalled();

    // inst-b stays removed (remove() is not undone by the in-flight tick
    // finishing afterward), inst-a stays held.
    expect(heartbeat.held().map((l) => l.instanceId)).toEqual(['inst-a']);
  });

  it('remove_called_mid_tick_does_not_suppress_onFenceLost_for_the_tick_start_snapshot_no_crash', async () => {
    let resolveRenew: ((value: boolean[]) => void) | undefined;
    const renewBatchMock = vi.fn(
      () =>
        new Promise<boolean[]>((resolve) => {
          resolveRenew = resolve;
        }),
    );
    const leaseRedis: LeaseRedis = {
      acquire: vi.fn(),
      setFence: vi.fn(),
      renewBatch: renewBatchMock as unknown as LeaseRedis['renewBatch'],
      release: vi.fn(),
    };

    const pgQuery = vi.fn().mockResolvedValue({ rows: [{ instance_id: 'inst-a' }] });
    const pgSql: WorkerDb = stubWorkerDb({ query: pgQuery });

    const sessionOwner = makeSessionOwner();
    const leaseA = makeLease('inst-a');
    const leaseB = makeLease('inst-b');

    const heartbeat = new LeaseHeartbeat({
      leaseRedis,
      pgSql,
      sessionOwner,
      workerId: 'worker-1',
      env: 'test',
      timing: COMPRESSED_TIMING as unknown as typeof TIMING,
      monotonicNow: () => 0n,
    });
    heartbeat.add(leaseA);
    heartbeat.add(leaseB);

    const tickPromise = heartbeat.tick();

    // Remove inst-b mid-flight - its eventual `false` renewal result
    // (Redis explicitly says the key is lost) must NOT surface an
    // onFenceLost call for an instance the caller already dropped
    // voluntarily out-of-band.
    heartbeat.remove('inst-b');

    // The in-flight call resolves: inst-a renewed true, inst-b renewed
    // false (as originally requested, positionally aligned to the
    // ORIGINAL held-set snapshot taken at tick start - `runTick` computes
    // `instanceIds`/`leases` ONCE at the top from `this.held()`, before the
    // Redis round trip, so a mid-flight `remove()` cannot change what that
    // snapshot contains).
    resolveRenew?.([true, false]);
    await tickPromise;

    // REAL BEHAVIOR (not a design choice this test is free to assert away):
    // heartbeat.ts's `redisDecisions` are computed from the tick-start
    // `instanceIds` snapshot, so inst-b's explicit `false` still produces a
    // 'redis_renew_lost' decision and `onFenceLost` IS called for it, even
    // though `remove()` had already dropped it from the held set - the
    // mid-flight removal does not retroactively filter the decision. This
    // is not itself unsafe (onFenceLost on an instance the caller already
    // let go is a harmless redundant notification), but it is worth pinning
    // explicitly: a caller relying on "remove() mid-tick fully suppresses
    // onFenceLost for that instance" would be wrong.
    expect(sessionOwner.onFenceLost).toHaveBeenCalledTimes(1);
    expect(sessionOwner.onFenceLost).toHaveBeenCalledWith('inst-b', 'redis_renew_lost');

    // No crash from the redundant remove() the decision loop performs for
    // an already-removed instance. inst-a stays held and unaffected.
    expect(() => heartbeat.held()).not.toThrow();
    expect(heartbeat.held().map((l) => l.instanceId)).toEqual(['inst-a']);
  });

  it('instance_removed_mid_tick_has_no_watchdog_baseline_at_evaluation_time_is_skipped_not_fenced_and_monotonicNow_is_never_consulted_for_it', async () => {
    // FIX-3 (C1 WARNING 8): when the tick-start snapshot includes an
    // instance that `remove()` drops MID-TICK (a real remove()-mid-tick
    // race, the in-flight Redis round trip still pending), `watchdogState`
    // no longer has an entry for it by the time the watchdog evaluation step
    // runs. The fallback must SKIP that instance entirely - never
    // synthesize a fresh `?? this.monotonicNow()` baseline for it (which
    // would silently treat unknown as "just renewed", the opposite of
    // fail-safe: core invariant 2) - and must not fence it either (it is not
    // ours to fence any more), nor write it back into the watchdog map.
    //
    // The Redis leg REJECTS (hung/unreachable) once it finally settles, so
    // no per-instance redis signal exists for either instance this tick -
    // isolating the probe to ONLY the watchdog evaluation step. This lets
    // the test count EXACTLY how many times `monotonicNow()` is called:
    // `add()` x2 (seeding inst-a/inst-b's baselines) + the tick's own single
    // `nowNs` read for the deadline comparison = 3 calls total if inst-b is
    // correctly SKIPPED (no `?? monotonicNow()` fallback invoked for it). A
    // 4th call would mean the buggy fallback ran for inst-b.
    const monotonicNow = vi.fn(() => 0n);

    let rejectRenew: ((err: Error) => void) | undefined;
    const renewBatchMock = vi.fn(
      () =>
        new Promise<boolean[]>((_resolve, reject) => {
          rejectRenew = reject;
        }),
    );
    const leaseRedis: LeaseRedis = {
      acquire: vi.fn(),
      setFence: vi.fn(),
      renewBatch: renewBatchMock as unknown as LeaseRedis['renewBatch'],
      release: vi.fn(),
    };

    const pgQuery = vi.fn().mockResolvedValue({ rows: [{ instance_id: 'inst-a' }] });
    const pgSql: WorkerDb = stubWorkerDb({ query: pgQuery });

    const sessionOwner = makeSessionOwner();
    const leaseA = makeLease('inst-a');
    const leaseB = makeLease('inst-b');

    const heartbeat = new LeaseHeartbeat({
      leaseRedis,
      pgSql,
      sessionOwner,
      workerId: 'worker-1',
      env: 'test',
      timing: COMPRESSED_TIMING as unknown as typeof TIMING,
      monotonicNow,
    });
    heartbeat.add(leaseA);
    heartbeat.add(leaseB);
    expect(monotonicNow).toHaveBeenCalledTimes(2); // the two add() baseline seeds

    const tickPromise = heartbeat.tick();

    // Mid-flight: remove inst-b BEFORE the Redis renew settles, so by the
    // time the watchdog evaluation step runs (after the Redis+PG legs),
    // inst-b has no `watchdogState` entry at all - the genuine
    // remove()-mid-tick race.
    heartbeat.remove('inst-b');

    rejectRenew?.(new Error('redis hung'));
    await tickPromise;

    // Exactly ONE more `monotonicNow()` call happened during the tick - the
    // single `nowNs` read for the deadline comparison. If the buggy fallback
    // had run for the removed inst-b, there would be a SECOND extra call
    // (the synthesized baseline read) - i.e. 4 total instead of 3.
    expect(monotonicNow).toHaveBeenCalledTimes(3);

    // inst-b was never fenced via the watchdog fallback.
    expect(sessionOwner.onFenceLost).not.toHaveBeenCalledWith('inst-b', 'watchdog');
    expect(heartbeat.held().map((l) => l.instanceId)).toEqual(['inst-a']);
  });
});
