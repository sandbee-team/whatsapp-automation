import { vi } from 'vitest';
import { TIMING } from '@wp/domain';
import type { WorkerDb, WorkerQueryable } from '@wp/db';
import type { LeaseQueryable } from './lease-state-repo.js';
import type { SessionOwner } from './session-owner.port.js';
import type { SessionLease } from './lease-manager.js';

/**
 * heartbeat-c2-test-support.ts (FIX-P09-B split) - shared fixtures for
 * `heartbeat.c2.test.ts`'s probes 3 and 4, mechanically extracted out of
 * that file (now split into `heartbeat.c2-overlap.test.ts` and
 * `heartbeat.c2-slow-redis.test.ts`) at FIX-P09-B for the max-lines cap. No
 * logic change - same helpers, same behavior.
 */

export const COMPRESSED_TIMING = {
  ...TIMING,
  heartbeatMs: 1_000,
  watchdogMs: 15_000,
  leaseTtlMs: 30_000,
  redisCommandTimeoutMs: 2_000,
} as const;

/**
 * Wraps a bare `LeaseQueryable` stub (this file's existing `pgQuery` mocks)
 * into a `WorkerDb` that simply hands the same stub straight to `fn` - no
 * real transaction/GUC (these are pure unit tests with no real Postgres),
 * matching `HeartbeatDeps.pgSql`'s post-C1-fix type exactly.
 */
export function stubWorkerDb(queryable: LeaseQueryable): WorkerDb {
  return {
    withWorker: (_workerId, fn) => fn(queryable as unknown as WorkerQueryable),
  };
}

/**
 * Deterministic replacement for the turn-counting flush this file used to
 * use: `lease-state-repo.ts`'s `renewBatch` reads `db/queries/
 * lease-renew-batch.sql` from disk asynchronously on the FIRST call in the
 * process (`loadQuery`, real fs I/O, cached only after that first call), so
 * the number of microtask/macrotask turns between `heartbeat.tick()` and the
 * PG `query()` stub actually being invoked is NOT fixed - it depends on how
 * long that fs read takes, which varies under full-suite parallel load. A
 * fixed-count `setImmediate` loop (the previous approach) is exactly the
 * kind of timing-turn-counting `.claude/rules/queue-workers.md` forbids:
 * it passed standalone/lightly loaded and flaked under full-suite
 * contention when the real read took longer than the loop's turn budget.
 *
 * Instead, each test's `pgQuery` stub resolves a `called` deferred promise
 * the FIRST time it is actually invoked; callers await that promise directly.
 */
export function deferredCalled(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export function makeLease(instanceId: string): SessionLease {
  return {
    instanceId,
    clientId: `client-${instanceId}`,
    fence: 1n,
    workerId: 'worker-1',
    graceMs: 0,
  };
}

export function makeSessionOwner(): SessionOwner {
  return { onFenceLost: vi.fn(), close: vi.fn() };
}
