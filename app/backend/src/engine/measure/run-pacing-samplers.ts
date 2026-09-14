import type { createPool } from '@wp/db';
import { reserve } from '../pacing/index.js';
import { bucketClaimSample } from '../../../../../scripts/measure/pacing-run.js';

/**
 * run-pacing-samplers.ts (P26 U5; C1 fix round FIX-B max-lines split off
 * `run-pacing-collect.ts` - same idiom as `session-worker-discovery-
 * wiring.ts`): the two REAL-OPERATION latency samplers (`reserve()` through
 * a given pool, claim-latency for non-bursting tenants). Both TIME a real
 * operation end-to-end - never a bare `SELECT 1` - per this phase's own
 * requirement.
 */

/**
 * Times ONE real `reserve()` call (the exact production pacing-grant path,
 * `engine/pacing/index.ts#reserve`) against `probeInstanceId`/`probeClientId`
 * through `pool` - never a bare `SELECT 1`. Returns the wall-clock duration
 * in milliseconds. The probe instance's own gap/caps make repeated calls
 * eventually deny (a deny still measures the real statement's latency - the
 * SLO is about `reserve()` wall time, not about always granting).
 */
export async function timeOneReserveCall(
  pool: ReturnType<typeof createPool>,
  probeInstanceId: string,
  probeClientId: string,
): Promise<number> {
  const startedAtMs = Date.now();
  await reserve({
    sql: pool,
    clientId: probeClientId,
    instanceId: probeInstanceId,
    isNewConversation: false,
    isGroup: false,
    gapMs: 1,
    clock: { now: () => Date.now() },
    timeZone: 'Asia/Kolkata',
    windowStartLocal: '00:00:00',
    windowEndLocal: '23:59:59',
  });
  return Date.now() - startedAtMs;
}

/**
 * Times ONE real claim-latency probe for a non-bursting tenant: a single
 * `SELECT ... FOR UPDATE SKIP LOCKED`-shaped read against that tenant's own
 * `message_jobs` queue depth, timed end-to-end - the same claim-eligibility
 * read `claim-jobs.sql` performs before its own conditional UPDATE, kept
 * read-only here so repeated sampling never itself consumes a job.
 */
export async function timeOneClaimProbe(
  pool: ReturnType<typeof createPool>,
  probeInstanceId: string,
  probeClientId: string,
): Promise<number> {
  const startedAtMs = Date.now();
  await pool.query(
    `SELECT id FROM message_jobs
       WHERE client_id = $2 AND instance_id = $1 AND status = 'queued' AND next_attempt_at <= now()
       ORDER BY priority_rank, scheduled_at
       LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [probeInstanceId, probeClientId],
  );
  return Date.now() - startedAtMs;
}

export interface StopSignal {
  stopped: boolean;
}

/** Runs `timeOneReserveCall` on a fixed cadence against `probeInstances` (round-robin) until `signal.stopped`, pushing every sample into `out`. */
export async function runReserveSamplerLoop(
  pool: ReturnType<typeof createPool>,
  probeInstances: readonly { instanceId: string; clientId: string }[],
  intervalMs: number,
  signal: StopSignal,
  out: number[],
): Promise<void> {
  while (!signal.stopped) {
    const probe = probeInstances[out.length % probeInstances.length];
    if (probe) {
      out.push(await timeOneReserveCall(pool, probe.instanceId, probe.clientId));
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Runs `timeOneClaimProbe` on a fixed cadence against `probeInstanceId` until
 * `signal.stopped`, bucketing each sample via the pure `bucketClaimSample`.
 *
 * `burstAtMs` MUST be the ABSOLUTE instant the burst fires at
 * (`runStartMs + burstAtSeconds * 1000`) - the SAME value handed to the send
 * driver's `burst.atMs` - because each sample is stamped with an absolute
 * `now()`. Handing a run-relative offset here puts every sample in `during`
 * and collapses the baseline to zero samples (P26 smoke, defect 1). `now` is
 * injected so the bucketing is testable without a real clock.
 */
export async function runClaimSamplerLoop(
  pool: ReturnType<typeof createPool>,
  probeInstanceId: string,
  probeClientId: string,
  intervalMs: number,
  burstAtMs: number,
  signal: StopSignal,
  before: number[],
  during: number[],
  now: () => number = () => Date.now(),
): Promise<void> {
  while (!signal.stopped) {
    const ms = await timeOneClaimProbe(pool, probeInstanceId, probeClientId);
    if (bucketClaimSample(now(), burstAtMs) === 'before') before.push(ms);
    else during.push(ms);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
