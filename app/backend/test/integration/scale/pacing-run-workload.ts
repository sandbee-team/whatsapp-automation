import type { Redis } from 'ioredis';
import { createTenantDb, type createPool } from '@wp/db';
import { createMeasureEnqueue } from '../../../src/engine/measure/measure-enqueue.js';
import {
  createScaleFleet,
  type ScaleFleet,
  type CreateScaleFleetOptions,
} from '../../../src/engine/measure/scale-fleet.js';
import type { SeededScaleFleet } from '../../../src/engine/measure/scale-fleet-seed.js';
import {
  runSendLoad,
  type SendLoadDriverDeps,
  type SendLoadResult,
} from '../../../src/engine/measure/send-load-driver.js';
import {
  collectJobCounts,
  collectDuplicateAckedAttemptCount,
} from '../../../src/engine/measure/run-pacing-collect.js';
import {
  resolveFleetInstances,
  setRunPacingCaps,
} from '../../../src/engine/measure/run-pacing-windows.js';
import {
  createMeasureSweeps,
  type MeasureSweeps,
} from '../../../src/engine/measure/measure-sweeps.js';

/**
 * pacing-run-workload.ts (P26 U5, step 5; C1 fix round FIX-B) - shared
 * fleet-stand-up/drive/collect helpers for `pacing-run.integration.test.ts`.
 * NOT itself a test file (no `.test.ts` suffix) - same idiom as the chaos
 * suite's own `chaos-fleet-workload.ts`.
 *
 * FLEET SIZE: 2 real worker child PROCESSES x 6 instances each (12 total),
 * COMPRESSED timing - small enough to drive+settle in seconds while still
 * exercising the real claim+reserve+dispatch loop through
 * `createScaleFleet` (U2a), never a toy in-memory stand-in.
 *
 * SINGLE SEED, ONLY (CRITICAL 2 fix): `fleet.start()` already seeds and
 * assigns every instance this fleet will ever have - a second
 * `seedScaleFleet` call here minted 12 PHANTOM instances no child was ever
 * assigned to (P26 run log #10), which enqueued load nobody claims and never
 * cleaned up on `fleet.stop()` (that only knows its OWN seeded ids). This
 * module now resolves the fleet's real instance set via
 * `resolveFleetInstances` and raises the daily cap by UPDATE on exactly
 * those rows via `setRunPacingCaps` - the same pattern `run-pacing.ts` uses.
 */

export const PACING_TEST_FLEET_PLAN = {
  workers: 2,
  instancesPerWorker: 6,
  tenants: 2,
  sessionCap: 8,
};

/**
 * MINOR g fix (FIX-P26-H, 2026-09-07): `1`, not `5` - `drivePacingTestLoad`
 * enqueues EXACTLY ONE job per instance, so a cap of 5 could never fail the
 * live cap assertion no matter what the run does (the assertion was
 * structurally always-true). At `1`, one send per instance sits EXACTLY at
 * the boundary: the live half genuinely proves the cap-violation scan can
 * see a real ledger row sitting AT its own `eff_daily_cap`, not merely
 * "under some unreachable ceiling".
 */
export const PACING_TEST_EFF_DAILY_CAP = 1;

export type PacingTestFleetHandles = CreateScaleFleetOptions['handles'];

export interface PacingTestFleet {
  fleet: ScaleFleet;
  seeded: SeededScaleFleet;
  sweeps: MeasureSweeps;
}

/**
 * Stands up one `ScaleFleet` at `PACING_TEST_FLEET_PLAN` scale, raises the
 * fleet's OWN assigned instances to a tight daily cap, and starts the
 * reaper+reconciler sweeps helper (Additional finding - a stranded
 * `processing` job can never drain without them) - the test's `beforeAll`
 * calls this once. Teardown (`fleet.stop()` + `sweeps.stop()`) is the
 * caller's own `afterAll`.
 */
export async function startPacingTestFleet(
  handles: PacingTestFleetHandles,
): Promise<PacingTestFleet> {
  const fleet = createScaleFleet({
    handles,
    plan: PACING_TEST_FLEET_PLAN,
    timing: { leaseTtlMs: 5_000, heartbeatMs: 500, takeoverGraceMs: 1_000 },
    childEnv: { WP_SCALE_NEVER_DIAL_GUARD: '1' },
  });
  await fleet.start();

  const resolved = await resolveFleetInstances(handles.pool, fleet);
  const instanceIds = resolved.instances.map((i) => i.instanceId);
  const capped = await setRunPacingCaps(
    handles.pool,
    instanceIds,
    resolved.clientIds,
    PACING_TEST_EFF_DAILY_CAP,
  );
  if (capped !== instanceIds.length) {
    throw new Error(
      `startPacingTestFleet: cap UPDATE touched ${String(capped)} rows, expected ${String(instanceIds.length)}`,
    );
  }

  const sweeps = createMeasureSweeps({
    pool: handles.pool,
    tenantDb: createTenantDb(handles.pool),
  });
  sweeps.start();

  return { fleet, seeded: resolved, sweeps };
}

/**
 * Builds the real two-table enqueue port - a thin binding over the SHARED
 * `measure-enqueue.ts#createMeasureEnqueue`, which also publishes the wake
 * the real enqueue publishes. `env: 'test'` matches the `env` the fleet
 * children boot their send loop with (`scale-fleet-child.ts`); the wake
 * channel is env-scoped, so a mismatch would land on a dead channel.
 */
export function buildTestEnqueue(
  pool: ReturnType<typeof createPool>,
  redisCtl: Redis,
): SendLoadDriverDeps['enqueue'] {
  return createMeasureEnqueue({ pool, redisCtl, env: 'test' });
}

/**
 * Drives `runSendLoad` over every seeded instance, enqueuing EXACTLY ONE job
 * per instance (an `intervalMs` equal to `durationMs` fires only the item's
 * first delay, never a second one within the window) - short enough for a
 * live integration test AND small enough to actually drain. Each seeded
 * instance's real `eff_gap_min_ms`/`eff_gap_max_ms` (15-30s, `scale-fleet-
 * seed.ts` defaults - the REAL production pacing gate, never shortened for
 * this test) means a flood of jobs per instance could never settle inside
 * any bounded test wait; one job per instance settles within one pacing
 * gate's worth of wall time. Returns the driver's own `SendLoadResult` so
 * the caller can assert conservation against an INDEPENDENT count, never
 * rows against themselves (CRITICAL 2(c)).
 */
export async function drivePacingTestLoad(
  pool: ReturnType<typeof createPool>,
  redisCtl: Redis,
  seeded: SeededScaleFleet,
  durationMs: number,
): Promise<SendLoadResult> {
  const plan = seeded.instances.map((instance, i) => ({
    clientId: instance.clientId,
    instanceId: instance.instanceId,
    intervalMs: durationMs,
    tenantKey: `t${String(i % 2)}`,
  }));
  return runSendLoad(
    plan,
    {
      enqueue: buildTestEnqueue(pool, redisCtl),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    { durationMs, jitterRatio: 0, rng: () => 0.5 },
  );
}

/** Bounded-wait poll - same idiom as `chaos-fleet-workload.ts#waitUntilOutcome`. */
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

/** Waits until every enqueued job for `clientIds` has left `queued`/`processing` (settled to a terminal-ish state), bounded by `deadlineMs`. */
export async function waitUntilJobsSettled(
  pool: ReturnType<typeof createPool>,
  clientIds: string[],
  deadlineMs: number,
): Promise<boolean> {
  return waitUntilOutcome(async () => {
    const counts = await collectJobCounts(pool, clientIds);
    return counts.stillQueued === 0;
  }, deadlineMs);
}

export { collectJobCounts, collectDuplicateAckedAttemptCount };
