import type { createPool } from '@wp/db';
import type { createRedis } from '../../../src/platform/redis.js';
import {
  createScaleFleet,
  type ScaleFleet,
  type CreateScaleFleetOptions,
} from '../../../src/engine/measure/scale-fleet.js';

/**
 * chaos-fleet-workload.ts (P26 U6b, step 6 chaos: worker-kill + redis-flush)
 * - shared fleet-stand-up/bounded-wait/counter-read helpers for
 *   `worker-kill.integration.test.ts` and `redis-flush.integration.test.ts`.
 * NOT itself a test file (no `.test.ts` suffix) - same idiom as U6a's own
 * `postgres-outage-workload.ts` sibling, so the four chaos tests read as one
 * suite.
 *
 * Both files stand up the SAME small-but-real fleet shape through
 * `createScaleFleet` (U2a): 3 real worker child PROCESSES x 8 instances each
 * (24 total), sessionCap 12, COMPRESSED child timing - see each test file's
 * own header for why this size/timing was chosen.
 *
 * `client_id`-scoped readers (`readFence`, `jobStatusTally`, ...) live in the
 * shared `run-chaos-fleet-reads.ts` (P26 C1 MAJOR 9). `countJobStatuses`
 * below is this file's own `client_id`-scoped tally (MINOR e fix, FIX-P26-H,
 * 2026-09-07 - it used to be unscoped).
 */

export const CHAOS_FLEET_PLAN = { workers: 3, instancesPerWorker: 8, tenants: 3, sessionCap: 12 };

export const CHAOS_COMPRESSED_TIMING = {
  leaseTtlMs: 5_000,
  heartbeatMs: 500,
  takeoverGraceMs: 1_000,
} as const;

export type ChaosFleetHandles = CreateScaleFleetOptions['handles'];

/** Stands up one `ScaleFleet` at `CHAOS_FLEET_PLAN` scale, COMPRESSED timing - both chaos files call this once in `beforeAll`. */
export async function startChaosFleet(handles: ChaosFleetHandles): Promise<ScaleFleet> {
  const fleet = createScaleFleet({
    handles,
    plan: CHAOS_FLEET_PLAN,
    timing: CHAOS_COMPRESSED_TIMING,
    childEnv: { WP_SCALE_NEVER_DIAL_GUARD: '1' },
  });
  await fleet.start();
  return fleet;
}

/** Bounded-wait poll: retries `predicate` until it resolves true or `deadlineMs` elapses. Never a bare sleep - callers assert the OUTCOME after this resolves, never elapsed time. */
export async function waitUntilOutcome(
  predicate: () => boolean | Promise<boolean>,
  deadlineMs: number,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export interface MessageJobStatusCounts {
  queued: number;
  processing: number;
  sent: number;
  failed: number;
  blocked_needs_review: number;
  needs_reconcile: number;
  other: number;
  total: number;
}

/**
 * Row-count-only tally of `message_jobs.status` for the given ids - never a
 * harness tally (invariant 7). `clientIds` is REQUIRED (invariant 4,
 * tenant isolation): a bare `WHERE id = ANY($1)` reads across every tenant
 * sharing this database, not just this fleet's own seeded jobs (MINOR e fix,
 * FIX-P26-H, 2026-09-07).
 */
export async function countJobStatuses(
  pool: ReturnType<typeof createPool>,
  jobIds: string[],
  clientIds: string[],
): Promise<MessageJobStatusCounts> {
  const counts: MessageJobStatusCounts = {
    queued: 0,
    processing: 0,
    sent: 0,
    failed: 0,
    blocked_needs_review: 0,
    needs_reconcile: 0,
    other: 0,
    total: 0,
  };
  if (jobIds.length === 0) return counts;
  const result = await pool.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM message_jobs
      WHERE id = ANY($1) AND client_id = ANY($2) GROUP BY status`,
    [jobIds, clientIds],
  );
  for (const row of result.rows) {
    const n = Number(row.count);
    counts.total += n;
    if (row.status in counts) {
      (counts as unknown as Record<string, number>)[row.status] = n;
    } else {
      counts.other += n;
    }
  }
  return counts;
}

/** `dbsize` on a given Redis handle - used to prove a flush drill never touched an untargeted keyspace (e.g. `redis-sig`). */
export async function dbSize(redis: ReturnType<typeof createRedis>): Promise<number> {
  return redis.dbsize();
}
