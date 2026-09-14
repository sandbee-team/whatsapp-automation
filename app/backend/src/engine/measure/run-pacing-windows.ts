import type { Redis } from 'ioredis';
import type { createPool } from '@wp/db';
import { describeError } from '@wp/server-kit';
import { createMeasureEnqueue } from './measure-enqueue.js';
import { percentile, fairnessVerdict } from '../../../../../scripts/measure/pacing-run.js';
import type {
  PacingReserveLatency,
  PacingRunBurst,
} from '../../../../../scripts/measure/pacing-run-artifact.js';
import type { SendLoadDriverDeps, SendLoadPlanItem } from './send-load-driver.js';
import {
  perInstanceIntervalMs,
  type ExpandedTenant,
} from '../../../../../scripts/loadtest/tenant-mix.js';
import type { PacingRunJobs } from '../../../../../scripts/measure/pacing-run-artifact.js';
import type { MeasureSweepsCounts } from './measure-sweeps.js';
import {
  runReserveSamplerLoop,
  runClaimSamplerLoop,
  type StopSignal,
} from './run-pacing-samplers.js';

/**
 * run-pacing-windows.ts (P26 U5) - max-lines split off `run-pacing.ts` (same
 * idiom as `session-worker-discovery-wiring.ts`): the pure sample-array ->
 * artifact-field derivations (every place a raw latency sample list becomes
 * a reported quantity), plus the harness's durable enqueue port.
 *
 * These live together because they share ONE rule: an EMPTY sample window is
 * `null` (UNMEASURED) and is named as its own problem - never a fabricated
 * `0`, and never an `Infinity` fairness ratio from dividing by an empty
 * baseline. Collapsing an unmeasured window to zero is what let the P26
 * smoke report `before=0ms ... ratio Infinity` for a run whose sampler had
 * simply bucketed every sample into the wrong window.
 */

/** Reserve-latency percentiles over the raw sample list. Zero samples reports zeros with `samples: 0`, which `collectProblems` already names as "never measured" - it is never mistaken for a fast run. */
export function deriveReserveLatency(samples: readonly number[]): PacingReserveLatency {
  if (samples.length === 0) {
    return { samples: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, sloMs: 25 };
  }
  return {
    samples: samples.length,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    p99Ms: percentile(samples, 99),
    maxMs: Math.max(...samples),
    sloMs: 25,
  };
}

export interface DeriveBurstWindowsInput {
  recipients: number;
  /** RUN-RELATIVE offset (ms from the drive-window start) the burst ACTUALLY fired at. */
  startedAtMs: number;
  before: readonly number[];
  during: readonly number[];
}

/**
 * Builds the artifact's `burst` block from the two raw claim-sample windows.
 * A window with no samples yields `null` for its p99 (never `0`), and the
 * fairness verdict is only COMPUTED when both windows carry samples -
 * otherwise `ratio` is `null` and `ok` is false, so the artifact reports
 * "not measured" rather than "infinitely unfair".
 */
export function deriveBurstWindows(input: DeriveBurstWindowsInput): PacingRunBurst {
  const beforeP99 = input.before.length > 0 ? percentile(input.before, 99) : null;
  const duringP99 = input.during.length > 0 ? percentile(input.during, 99) : null;
  const fairness =
    beforeP99 !== null && duringP99 !== null
      ? fairnessVerdict({ baselineP99Ms: beforeP99, duringBurstP99Ms: duringP99 })
      : { ok: false, ratio: null };
  return {
    recipients: input.recipients,
    startedAtMs: input.startedAtMs,
    otherTenantsClaimP99BeforeMs: beforeP99,
    otherTenantsClaimP99DuringMs: duringP99,
    samplesBefore: input.before.length,
    samplesDuring: input.during.length,
    fairness: { ok: fairness.ok, ratio: fairness.ratio },
  };
}

/**
 * The harness's DURABLE enqueue port (invariant 1: every send starts as a
 * durable job row) - now a thin binding over the SHARED
 * `measure-enqueue.ts#createMeasureEnqueue`, the one authority for this
 * two-table insert AND for the wake publish that follows it. Without the
 * wake this run was poll-bound (60s +/- 12s safety poll) rather than
 * pacing-bound; see that module's header. `env` is `'test'` because the
 * fleet children boot their send loop with `env: 'test'`
 * (`scale-fleet-child.ts`) and the wake channel is env-scoped.
 */
export function createRunPacingEnqueue(
  pool: ReturnType<typeof createPool>,
  redisCtl: Redis,
): SendLoadDriverDeps['enqueue'] {
  return createMeasureEnqueue({ pool, redisCtl, env: 'test' });
}

/**
 * Resolves the instances `fleet.start()` ACTUALLY seeded and assigned, via
 * the fleet's own owner map - the ONLY source of this run's instance set.
 *
 * A second `seedScaleFleet` call would mint instances no worker is ever
 * assigned to: they enqueue jobs nobody claims, they add `pacing_ledger` and
 * `instance_pacing_state` rows that skew the cap-violation scan, and their
 * tenants outlive `fleet.stop()` (which only knows its own ids) as leaked
 * `Scale Fleet Probe` clients. Same rule as
 * `run-pg-load-fleet.ts#buildSendPlanFromFleet`: never a second seed.
 */
export async function resolveFleetInstances(
  pool: ReturnType<typeof createPool>,
  fleet: { ownerMap: () => Promise<Map<string, string>>; clientIds: () => string[] },
): Promise<{ instances: { instanceId: string; clientId: string }[]; clientIds: string[] }> {
  const instanceIds = Array.from((await fleet.ownerMap()).keys());
  if (instanceIds.length === 0) return { instances: [], clientIds: [] };
  // Tenant-scoped (invariant 4): only the fleet's OWN seeded tenants.
  const result = await pool.query<{ id: string; client_id: string }>(
    'SELECT id, client_id FROM whatsapp_instances WHERE id = ANY($1) AND client_id = ANY($2) ORDER BY id',
    [instanceIds, fleet.clientIds()],
  );
  const instances = result.rows.map((r) => ({ instanceId: r.id, clientId: r.client_id }));
  return { instances, clientIds: [...new Set(instances.map((i) => i.clientId))] };
}

/**
 * Raises `eff_daily_cap`/`eff_new_conv_cap` on exactly the fleet's OWN
 * assigned instances (`= ANY($1)`, never table-wide) to the run-derived cap,
 * so the run genuinely approaches a cap without a second seed. Returns the
 * rows actually updated - the caller treats a short count as a hard error.
 * Mirrors `run-pg-load-fleet.ts#raiseSeededPacingCaps`.
 */
export async function setRunPacingCaps(
  pool: ReturnType<typeof createPool>,
  instanceIds: string[],
  clientIds: string[],
  dailyCap: number,
): Promise<number> {
  if (instanceIds.length === 0) return 0;
  const result = await pool.query(
    `UPDATE instance_pacing_state SET eff_daily_cap = $3, eff_new_conv_cap = $3, updated_at = now()
      WHERE instance_id = ANY($1) AND client_id = ANY($2)`,
    [instanceIds, clientIds, dailyCap],
  );
  return result.rowCount ?? 0;
}

/**
 * Assembles the artifact's `jobs` block from the row-based counts
 * (`collectJobCounts`/`collectDuplicateAckedAttemptCount`), the load
 * DRIVER's own count, and the ledger row count examined for cap violations.
 * `driverEnqueued` is an INDEPENDENT source from the row buckets - never
 * derived from them - so `collectProblems`'s conservation check is not a
 * tautology (CRITICAL 2(c)); `ledgerRowCount` lets it tell "zero violations
 * over zero rows" apart from a genuinely clean run (CRITICAL 2(b)/MAJOR 3).
 */
export function buildPacingRunJobs(input: {
  jobCounts: Omit<
    PacingRunJobs,
    'enqueued' | 'duplicateAckedAttempts' | 'driverEnqueued' | 'ledgerRowCount'
  > & {
    enqueued: number;
  };
  driverEnqueued: number;
  ledgerRowCount: number;
  duplicateAckedAttempts: number;
}): PacingRunJobs {
  return {
    ...input.jobCounts,
    driverEnqueued: input.driverEnqueued,
    ledgerRowCount: input.ledgerRowCount,
    duplicateAckedAttempts: input.duplicateAckedAttempts,
  };
}

/** Renders the reaper/reconciler sweep-counts note appended to every artifact (the "Additional finding" fix) - one place so `run-pacing.ts` stays under the max-lines cap. */
export function formatSweepCountsNote(counts: MeasureSweepsCounts): string {
  return (
    'reaper/reconciler sweeps ran on production cadence during the drive window: ' +
    `reaperRepairs=${String(counts.reaperRepairs)}, ` +
    `reconcilerResolved=${String(counts.reconcilerResolved)}, ` +
    `reconcilerBlocked=${String(counts.reconcilerBlocked)}.`
  );
}

/** Awaits a cleanup step, reporting but never rethrowing - one failed step must never skip the others or mask the original error (moved from `run-pacing.ts` for that file's own max-lines cap). */
export async function settleCleanup(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (err) {
    console.error(`run-pacing: cleanup step failed: ${describeError(err)}`);
  }
}

const RESERVE_SAMPLE_INTERVAL_MS = 500;
const CLAIM_SAMPLE_INTERVAL_MS = 500;

export interface PacingSamplerHandles {
  signal: StopSignal;
  reserveSamples: number[];
  claimSamplesBefore: number[];
  claimSamplesDuring: number[];
  /** Awaits both loops after `signal.stopped = true` is set. */
  join(): Promise<void>;
}

/**
 * Wires the reserve-latency + non-bursting-tenant claim-latency samplers
 * (moved out of `run-pacing.ts` for that file's own max-lines cap) - both
 * run continuously against `samplePool` until `signal.stopped`, per this
 * module's own RESERVE LATENCY SAMPLING / FAIRNESS WINDOWS contract.
 */
export function startPacingSamplers(
  samplePool: ReturnType<typeof createPool>,
  probeInstances: readonly { instanceId: string; clientId: string }[],
  nonBurstProbe: { instanceId: string; clientId: string } | undefined,
  burstAtMs: number,
): PacingSamplerHandles {
  const signal: StopSignal = { stopped: false };
  const reserveSamples: number[] = [];
  const claimSamplesBefore: number[] = [];
  const claimSamplesDuring: number[] = [];

  const reserveSamplerLoop = runReserveSamplerLoop(
    samplePool,
    probeInstances,
    RESERVE_SAMPLE_INTERVAL_MS,
    signal,
    reserveSamples,
  );
  const claimSamplerLoop = nonBurstProbe
    ? runClaimSamplerLoop(
        samplePool,
        nonBurstProbe.instanceId,
        nonBurstProbe.clientId,
        CLAIM_SAMPLE_INTERVAL_MS,
        burstAtMs,
        signal,
        claimSamplesBefore,
        claimSamplesDuring,
      )
    : Promise.resolve();

  return {
    signal,
    reserveSamples,
    claimSamplesBefore,
    claimSamplesDuring,
    async join(): Promise<void> {
      await Promise.all([reserveSamplerLoop, claimSamplerLoop]);
    },
  };
}

/**
 * Pairs each expanded tenant class with the seeded instances belonging to it
 * (in seed order) to produce the steady-state send plan: one entry per
 * instance, paced at its own class's `perInstanceIntervalMs`. Instances
 * beyond the seeded set are skipped rather than faked.
 */
export function buildSendPlan(
  tenants: readonly ExpandedTenant[],
  instances: readonly { clientId: string; instanceId: string }[],
): SendLoadPlanItem[] {
  const sendPlan: SendLoadPlanItem[] = [];
  let cursor = 0;
  for (const tenant of tenants) {
    for (let i = 0; i < tenant.instances; i += 1) {
      const instance = instances[cursor];
      cursor += 1;
      if (!instance) continue;
      sendPlan.push({
        clientId: instance.clientId,
        instanceId: instance.instanceId,
        intervalMs: perInstanceIntervalMs(tenant.sendsPerDayPerInstance),
        tenantKey: tenant.key,
      });
    }
  }
  return sendPlan;
}
