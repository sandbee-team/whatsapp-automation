import type { createPool } from '@wp/db';
import { createScaleFleet, type ScaleFleet } from '../../../src/engine/measure/scale-fleet.js';
import { createMeasureEnqueue } from '../../../src/engine/measure/measure-enqueue.js';
import { resolveFleetInstances } from '../../../src/engine/measure/run-pacing-windows.js';
import { countStillOwnedBy } from '../../../src/engine/measure/run-chaos-fleet-reads.js';
import { waitUntilOutcome } from './chaos-fleet-workload.js';
import type { ChaosFleetHandles } from './chaos-fleet-workload.js';

/**
 * rolling-deploy-workload.ts (P26 U6c, step 6 chaos: rolling-deploy) - the
 * shared fleet-stand-up/seed/read/roll helpers for
 * `rolling-deploy.integration.test.ts` and its `rolling-deploy-wave.
 * integration.test.ts` sibling. Sized independently of U6b's own
 * `CHAOS_FLEET_PLAN` (chaos-fleet-workload.ts) so a concurrent run never
 * shares a fleet identity with the worker-kill/redis-flush drills - 4
 * workers x 6 instances (24 total), sessionCap 12, same COMPRESSED timing
 * class as U6b. Row readers scoped by `client_id` (`readCredVersions`,
 * `readLinkStates`, `countSendAttempts`) and the seeding block are imported
 * from the shared `run-chaos-fleet-reads.ts`/`measure-enqueue.ts` rather than
 * duplicated here (P26 C1 MAJOR 8/9).
 */

export const ROLLING_FLEET_PLAN = { workers: 4, instancesPerWorker: 6, tenants: 4, sessionCap: 12 };

export const ROLLING_COMPRESSED_TIMING = {
  leaseTtlMs: 5_000,
  heartbeatMs: 500,
  takeoverGraceMs: 1_000,
} as const;

export const ROLLING_WORKER_IDS: readonly string[] = Array.from(
  { length: ROLLING_FLEET_PLAN.workers },
  (_, i) => `scale-worker-${String(i)}`,
);

/**
 * Stands up one `ScaleFleet` at `ROLLING_FLEET_PLAN` scale, COMPRESSED timing.
 *
 * CHILD LOADER (workaround for a live defect OUTSIDE this unit's file scope):
 * `scale-fleet.ts#spawnChild` derives each child's exec argv from
 * `childExecArgv({ parentExecArgv: process.execArgv, ... })`, whose rule is
 * "a child loads TypeScript the way its parent did". Under VITEST that rule
 * misfires: a vitest worker's own `process.execArgv` contains
 * `--require <vitest>/suppress-warnings.cjs`, which `loaderFlagsOf` counts as
 * a loader-class flag, so the inherited-flags branch wins and the tsx loader
 * is never passed - every child then crashes on its `.ts` entry before it can
 * send `ready`, and the parent only reports a bare IPC timeout. Measured
 * here: `fleet.start()` takes ~6s standalone but times out at 60s under
 * vitest, which currently reds U6b's already-landed chaos files too. This
 * helper therefore sets the documented operator override
 * (`WP_SCALE_CHILD_EXEC_ARGV`, priority 1 in `child-exec-argv.ts`) for its
 * OWN children only, restoring the historical default. The real fix belongs
 * in `child-exec-argv.ts` (ignore `suppress-warnings.cjs`, or require a
 * loader that actually handles TS) - reported, not silently patched here.
 */
export async function startRollingFleet(handles: ChaosFleetHandles): Promise<ScaleFleet> {
  // No loader override: `child-exec-argv.ts` now ignores vitest's CJS preload
  // and inherits only TS-capable loaders, so the default `--import tsx` applies
  // here and the parent's Linux loader applies in-container (C1 MAJOR).
  const fleet = createScaleFleet({
    handles,
    plan: ROLLING_FLEET_PLAN,
    timing: ROLLING_COMPRESSED_TIMING,
    childEnv: { WP_SCALE_NEVER_DIAL_GUARD: '1' },
  });
  await fleet.start();
  return fleet;
}

/** The instance ids `instance_lease_state` currently records as owned by `workerId` - read from the fleet's own `ownerMap()` (rows), never a harness tally. */
export async function instancesOwnedBy(fleet: ScaleFleet, workerId: string): Promise<string[]> {
  const owners = await fleet.ownerMap();
  return [...owners.entries()].filter(([, owner]) => owner === workerId).map(([id]) => id);
}

export interface RollOneWorkerResult {
  targetInstanceIds: string[];
  exitCode: number | undefined;
  /** How many of this wave's instances were still recorded against the just-drained worker immediately after `drain()` resolved - see `countStillOwnedBy`'s own GROUND TRUTH note (`run-chaos-fleet-reads.ts`). */
  unownedAfterDrain: number;
  reassignedCount: number;
  /** `true` once every one of this wave's instances is owned by the replacement again, within `outcomeDeadlineMs`. */
  reowned: boolean;
}

/**
 * Rolls exactly ONE worker the way a real rolling deploy does: graceful
 * `drain` (asserted exit 0 by the caller) -> `spawn` a replacement under the
 * same worker id -> parent-driven `reassignDeadWorkerInstances` -> bounded
 * OUTCOME wait until every one of that worker's instances is owned again.
 * Never sleeps on a fixed delay and never asserts elapsed time - callers
 * assert only the returned OUTCOMES.
 */
export async function rollOneWorker(
  fleet: ScaleFleet,
  pool: ReturnType<typeof createPool>,
  workerId: string,
  outcomeDeadlineMs = 45_000,
): Promise<RollOneWorkerResult> {
  const targetInstanceIds = await instancesOwnedBy(fleet, workerId);
  const exitCode = await fleet.drain(workerId);
  const unownedAfterDrain = await countStillOwnedBy(
    pool,
    targetInstanceIds,
    [workerId],
    fleet.clientIds(),
  );
  await fleet.spawn(workerId);
  const results = await fleet.reassignDeadWorkerInstances(workerId, [workerId]);
  const reowned = await waitUntilOutcome(async () => {
    const after = await fleet.ownerMap();
    return targetInstanceIds.every((id) => after.get(id) === workerId);
  }, outcomeDeadlineMs);
  return {
    targetInstanceIds,
    exitCode,
    unownedAfterDrain,
    reassignedCount: results.length,
    reowned,
  };
}

/**
 * Seeds a WAKE-PUBLISHED `message_jobs` backlog for every instance the fleet
 * already assigned (`resolveFleetInstances` - never a second seed, same rule
 * as `run-pg-load-fleet.ts#buildSendPlanFromFleet`), via the shared
 * `createMeasureEnqueue` port. Returns the seeded job ids.
 *
 * WHY WAKE-PUBLISHED, NOT A BARE INSERT (P26 C1 MAJOR 8): the old
 * `seedQueuedJobsForInstances` inserted `message_jobs` rows directly with no
 * wake, so a job seeded AFTER `fleet.start()` was never claimed until the 60s
 * safety poll - `sendsObserved` read 0 and the test's own note called that
 * "a live defect" rather than fixing the seeding. The child's send loop
 * subscribes to wakes from `fleet.start()` onward, so a wake-published
 * backlog is claimed immediately.
 */
export async function seedWakePublishedJobsForInstances(
  pool: ReturnType<typeof createPool>,
  fleet: ScaleFleet,
  handles: ChaosFleetHandles,
  jobsPerInstance = 1,
): Promise<string[]> {
  const seeded = await resolveFleetInstances(pool, fleet);
  const enqueue = createMeasureEnqueue({ pool, redisCtl: handles.redisCtl, env: 'test' });
  const jobIds: string[] = [];
  for (const inst of seeded.instances) {
    for (let i = 0; i < jobsPerInstance; i += 1) {
      const idempotencyKey = crypto.randomUUID();
      await enqueue({
        clientId: inst.clientId,
        instanceId: inst.instanceId,
        recipientJid: `${crypto.randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
        text: `rolling-deploy-probe ${String(i)} ${idempotencyKey.slice(0, 8)}`,
        idempotencyKey,
      });
    }
  }
  const rows = await pool.query<{ message_job_id: string }>(
    'SELECT message_job_id FROM message_job_refs WHERE instance_id = ANY($1) AND client_id = ANY($2)',
    [seeded.instances.map((i) => i.instanceId), seeded.clientIds],
  );
  jobIds.push(...rows.rows.map((r) => r.message_job_id));
  return jobIds;
}

export interface JobStatusAggregate {
  queued: number;
  processing: number;
  sent: number;
  failed: number;
  cancelled: number;
  needs_reconcile: number;
  blocked_needs_review: number;
  other: number;
  total: number;
}

/**
 * Row-count-only status tally for the given job ids - never a harness tally
 * (invariant 7). `clientIds` is REQUIRED (invariant 4, tenant isolation): a
 * bare `WHERE id = ANY($1)` reads across every tenant sharing this database,
 * not just this fleet's own seeded jobs (MINOR e fix, FIX-P26-H,
 * 2026-09-07).
 */
export async function aggregateJobStatuses(
  pool: ReturnType<typeof createPool>,
  jobIds: string[],
  clientIds: string[],
): Promise<JobStatusAggregate> {
  const out: JobStatusAggregate = {
    queued: 0,
    processing: 0,
    sent: 0,
    failed: 0,
    cancelled: 0,
    needs_reconcile: 0,
    blocked_needs_review: 0,
    other: 0,
    total: 0,
  };
  if (jobIds.length === 0) return out;
  const result = await pool.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM message_jobs
      WHERE id = ANY($1) AND client_id = ANY($2) GROUP BY status`,
    [jobIds, clientIds],
  );
  for (const row of result.rows) {
    const n = Number(row.count);
    out.total += n;
    if (row.status in out) {
      (out as unknown as Record<string, number>)[row.status] = n;
    } else {
      out.other += n;
    }
  }
  return out;
}

// The "mid-roll, not yet reassigned" reader (formerly `countUnownedInstances`
// here) and the `send_attempts` liveness reader (formerly `countSendAttempts`
// here) are now the shared, `client_id`-scoped `countStillOwnedBy` /
// `countSendAttempts` from `run-chaos-fleet-reads.ts` (P26 C1 MAJOR 9) -
// GROUND TRUTH note (a graceful `drain()` leaves `owner_worker_id` pointed at
// the drained worker until `reassignDeadWorkerInstances` completes) lives on
// that shared reader now, not duplicated here.
