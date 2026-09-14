import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSyntheticFleetHandles,
  disposeSyntheticFleetHandles,
  type SyntheticFleetHandles,
} from '../../../src/engine/session/synthetic-fleet-support.js';
import type { ScaleFleet } from '../../../src/engine/measure/scale-fleet.js';
import type { SeededScaleFleet } from '../../../src/engine/measure/scale-fleet-seed.js';
import type { MeasureSweeps } from '../../../src/engine/measure/measure-sweeps.js';
import type { SendLoadResult } from '../../../src/engine/measure/send-load-driver.js';
import {
  findCapViolations,
  fairnessVerdict,
  type LedgerRow,
  type PacingStateRow,
} from '../../../../../scripts/measure/pacing-run.js';
import { validatePacingRunArtifact } from '../../../../../scripts/measure/pacing-run-verify.js';
import {
  collectLedgerRows,
  collectPacingStateRows,
} from '../../../src/engine/measure/run-pacing-collect.js';
import {
  startPacingTestFleet,
  drivePacingTestLoad,
  waitUntilJobsSettled,
  collectJobCounts,
  collectDuplicateAckedAttemptCount,
} from './pacing-run-workload.js';
import { buildPacingRunArtifact } from '../../../../../scripts/measure/pacing-run-artifact.js';

/**
 * pacing-run.integration.test.ts (P26 U5, step 5 - THE CORE OF GATE B; C1
 * fix round FIX-B) - four named cases. Per this phase's own instruction:
 *
 *   - `zero_cap_violations_over_the_scaled_run` and
 *     `the_run_ends_with_zero_lost_failed_or_duplicated_jobs` are LIVE: a
 *     small-but-real fleet (2 workers x 6 instances, `pacing-run-workload.ts`)
 *     drives a short, compressed-timing load and asserts the row-based
 *     verdict functions over REAL ledger/state/job/wa-id rows - fast and
 *     deterministic (bounded-outcome polling only, never a sleep-and-hope).
 *     Each ALSO carries a RED-PROOF: a hand-built fixture that must fail,
 *     proving the assertion is not vacuously true.
 *
 *     CRITICAL 2 fix: both cases now assert the DRIVE itself was non-vacuous
 *     BEFORE trusting any row-based identity over it - `waitUntilJobsSettled`
 *     must actually return `true` (not just be called), `counts.sent` must
 *     be `> 0`, and `ledger.length` must be `> 0`. A cap scan or a
 *     conservation check over zero rows is not evidence (invariant 7). The
 *     load is driven ONCE, in `beforeAll`, against the fleet's own real
 *     assigned instances (`startPacingTestFleet` - no second seed); its
 *     `SendLoadResult` is shared by both live cases so conservation can
 *     compare the DRIVER's own count against the row-based buckets, never
 *     rows against themselves.
 *
 *   - `reserve_p99_stays_under_twenty_five_milliseconds` and
 *     `a_hundred_thousand_recipient_burst_does_not_raise_other_tenants_
 *     claim_latency_p99` are NOT live-timing assertions (core-invariants:
 *     never assert a wall-clock margin or a sampled race outcome) - they
 *     assert the VERDICT FUNCTIONS (`validatePacingRunArtifact`,
 *     `fairnessVerdict`) over committed artifact-shaped fixtures. The REAL
 *     p99 numbers for the 60-minute/8-hour runs come from the main
 *     session's own `run-pacing.ts` execution, whose artifact
 *     `pacing-run-verify.ts --verify <path>` checks against these exact
 *     same SLOs.
 */

let handles: SyntheticFleetHandles;
let fleet: ScaleFleet;
let seeded: SeededScaleFleet;
let sweeps: MeasureSweeps;
let driveResult: SendLoadResult;
let settled: boolean;

beforeAll(async () => {
  handles = createSyntheticFleetHandles();
  const started = await startPacingTestFleet(handles);
  fleet = started.fleet;
  seeded = started.seeded;
  sweeps = started.sweeps;

  // ONE job per instance (see `drivePacingTestLoad`'s own doc: `intervalMs`
  // equal to `durationMs` fires exactly once). The settle wait is bounded at
  // 45s to clear the real `eff_gap_max_ms` (30s, `scale-fleet-seed.ts`
  // default) plus wake/safety-poll latency - bounded-outcome polling only,
  // never a sleep-and-hope.
  driveResult = await drivePacingTestLoad(handles.pool, handles.redisCtl, seeded, 200);
  settled = await waitUntilJobsSettled(handles.pool, seeded.clientIds, 45_000);
}, 60_000);

afterAll(async () => {
  sweeps.stop();
  await fleet.stop();
  await disposeSyntheticFleetHandles(handles);
}, 30_000);

describe('pacing-run (fleet scale, P26 U5) - row-based live cases', () => {
  it('zero_cap_violations_over_the_scaled_run', async () => {
    // The drive must have genuinely settled - a `waitUntilJobsSettled`
    // timeout means the fleet never claimed anything, and a cap scan over
    // that is not evidence of "zero violations" (CRITICAL 2).
    //
    // MINOR g fix (FIX-P26-H, 2026-09-07): `PACING_TEST_EFF_DAILY_CAP` is `1`
    // and `drivePacingTestLoad` sends EXACTLY ONE job per instance, so the
    // real ledger consumed_count sits EXACTLY AT its own eff_daily_cap. This
    // live case therefore proves the cap-violation scan can see a genuine
    // ledger row sitting AT the boundary and still correctly report zero
    // violations (`>` the cap, not `>=`) - not merely "under some cap the
    // run could never approach" (the old cap of 5 against one send could
    // never fail this assertion no matter what the implementation did).
    expect(settled).toBe(true);

    const instanceIds = seeded.instances.map((i) => i.instanceId);
    const ledger = await collectLedgerRows(handles.pool, instanceIds, seeded.clientIds);
    const state = await collectPacingStateRows(handles.pool, instanceIds, seeded.clientIds);
    expect(ledger.length).toBeGreaterThan(0);
    expect(findCapViolations(ledger, state)).toEqual([]);

    // RED-PROOF: a hand-built ledger row exceeding its own state's daily cap
    // yields exactly one violation of the right kind - proves the live
    // assertion above is not vacuously true.
    const redState: PacingStateRow[] = [
      {
        instanceId: 'red',
        clientId: 'red-c',
        effDailyCap: 5,
        effHourlyCap: 5,
        effNewConvCap: 5,
        effGroupDailyCap: 5,
      },
    ];
    const redLedger: LedgerRow[] = [
      {
        instanceId: 'red',
        clientId: 'red-c',
        ledgerDate: '2026-09-07',
        consumedCount: 6,
        sentThisHour: 1,
        hourKey: 0,
        newConvCount: 0,
        groupSentCount: 0,
      },
    ];
    expect(findCapViolations(redLedger, redState)).toEqual([
      { instanceId: 'red', kind: 'daily', observed: 6, limit: 5 },
    ]);
  }, 30_000);

  it('the_run_ends_with_zero_lost_failed_or_duplicated_jobs', async () => {
    expect(settled).toBe(true);

    const counts = await collectJobCounts(handles.pool, seeded.clientIds);
    const duplicateAckedAttempts = await collectDuplicateAckedAttemptCount(
      handles.pool,
      seeded.clientIds,
    );
    expect(counts.sent).toBeGreaterThan(0);

    // Conservation compares the load DRIVER's own count (an independent
    // source - `runSendLoad`'s own `enqueued + burstEnqueued`) against the
    // row-based bucket sum, never rows against themselves: `counts.enqueued`
    // is ITSELF derived from the same GROUP BY as the bucket sum, so
    // comparing the two is a tautology that a vacuous zero-claim run still
    // satisfies (CRITICAL 2(c)).
    const driverEnqueued = driveResult.enqueued + driveResult.burstEnqueued;
    const jobSum =
      counts.sent +
      counts.stillQueued +
      counts.terminalFailed +
      counts.blockedNeedsReview +
      counts.cancelled;
    expect(driverEnqueued).toBe(jobSum);

    // FIX-P26-H MAJOR B: `message_wa_ids_message_id_uq UNIQUE (client_id,
    // instance_id, message_id)` (migration 0026) already PREVENTS a second
    // `message_wa_ids` row for the same message_id at the storage layer -
    // grouping on it (the old `collectDuplicateWaIdCount`) could never
    // observe a real duplicate. `collectDuplicateAckedAttemptCount` instead
    // groups `send_attempts` on `message_job_id` where `state = 'acked'`:
    // more than one acked attempt for the same job is the real symptom of a
    // double-dispatch, since `(message_job_id, attempt_no)` does not forbid
    // two different attempt numbers both reaching `acked`.
    expect(duplicateAckedAttempts).toBe(0);

    // RED-PROOF: a fixture where the driver count is short by one, or a
    // fixture with zero sent/zero ledger rows, is each its own named
    // problem - proving the live assertions above are not vacuously true.
    const shortArtifact = buildPacingRunArtifact({
      schemaVersion: 1,
      kind: 'pacing-run',
      capturedAtIso: '2026-09-07T00:00:00.000Z',
      hardware: { cpuModel: 'x', cpuCount: 1, totalMemBytes: 1, kernel: 'x', cgroupVersion: 2 },
      node: 'v24.20.0',
      run: { plannedSeconds: 60, measuredSeconds: 60, instances: 12, workers: 2, tenants: 2 },
      connection: { viaPgBouncer: true, poolMode: 'transaction', label: 'THROUGH-PGBOUNCER' },
      reserveLatency: { samples: 10, p50Ms: 1, p95Ms: 2, p99Ms: 3, maxMs: 4, sloMs: 25 },
      capViolations: [],
      jobs: {
        enqueued: 9,
        driverEnqueued: 10,
        ledgerRowCount: 12,
        sent: 8,
        stillQueued: 1,
        terminalFailed: 0,
        blockedNeedsReview: 0,
        cancelled: 0,
        duplicateAckedAttempts: 0,
      },
      burst: null,
      orphanReservations: { measurable: false, reason: 'no v1 detector' },
    });
    expect(shortArtifact.verdict).toBe('FAIL');
    expect(shortArtifact.problems.some((p) => p.includes('job conservation broken'))).toBe(true);

    const vacuousArtifact = buildPacingRunArtifact({
      ...shortArtifact,
      jobs: {
        enqueued: 0,
        driverEnqueued: 0,
        ledgerRowCount: 0,
        sent: 0,
        stillQueued: 0,
        terminalFailed: 0,
        blockedNeedsReview: 0,
        cancelled: 0,
        duplicateAckedAttempts: 0,
      },
    });
    expect(vacuousArtifact.verdict).toBe('FAIL');
    expect(vacuousArtifact.problems).toContain('jobs.sent is 0 - nothing was ever claimed');
    expect(vacuousArtifact.problems).toContain('pacing_ledger has 0 rows for the fleet');
  }, 30_000);
});

describe('pacing-run (P26 U5) - fixture-based verdict cases (never live timing)', () => {
  it('reserve_p99_stays_under_twenty_five_milliseconds', () => {
    const passArtifact = buildPacingRunArtifact({
      schemaVersion: 1,
      kind: 'pacing-run',
      capturedAtIso: '2026-09-07T00:00:00.000Z',
      hardware: { cpuModel: 'x', cpuCount: 1, totalMemBytes: 1, kernel: 'x', cgroupVersion: 2 },
      node: 'v24.20.0',
      run: {
        plannedSeconds: 3600,
        measuredSeconds: 3600,
        instances: 1000,
        workers: 10,
        tenants: 3,
      },
      connection: { viaPgBouncer: true, poolMode: 'transaction', label: 'THROUGH-PGBOUNCER' },
      reserveLatency: { samples: 5000, p50Ms: 2, p95Ms: 10, p99Ms: 24.9, maxMs: 26, sloMs: 25 },
      capViolations: [],
      jobs: {
        enqueued: 100,
        driverEnqueued: 100,
        ledgerRowCount: 12,
        sent: 100,
        stillQueued: 0,
        terminalFailed: 0,
        blockedNeedsReview: 0,
        cancelled: 0,
        duplicateAckedAttempts: 0,
      },
      burst: null,
      orphanReservations: { measurable: false, reason: 'no v1 detector' },
    });
    expect(validatePacingRunArtifact(passArtifact)).toEqual({ ok: true, problems: [] });

    for (const p99Ms of [25.0, 26.1]) {
      const failArtifact = buildPacingRunArtifact({
        ...passArtifact,
        reserveLatency: { samples: 5000, p50Ms: 2, p95Ms: 10, p99Ms, maxMs: 30, sloMs: 25 },
      });
      const result = validatePacingRunArtifact(failArtifact);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.includes('reserveLatency.p99Ms'))).toBe(true);
    }

    const zeroSamplesArtifact = buildPacingRunArtifact({
      ...passArtifact,
      reserveLatency: { samples: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, sloMs: 25 },
    });
    const zeroResult = validatePacingRunArtifact(zeroSamplesArtifact);
    expect(zeroResult.ok).toBe(false);
    expect(zeroResult.problems.some((p) => p.includes('samples is 0'))).toBe(true);
  });

  it('a_hundred_thousand_recipient_burst_does_not_raise_other_tenants_claim_latency_p99', () => {
    const ok = fairnessVerdict({ baselineP99Ms: 40, duringBurstP99Ms: 47 });
    expect(ok.ok).toBe(true);
    expect(ok.ratio).toBeCloseTo(1.175, 10);

    const notOk = fairnessVerdict({ baselineP99Ms: 40, duringBurstP99Ms: 49 });
    expect(notOk.ok).toBe(false);
    expect(notOk.ratio).toBeCloseTo(1.225, 10);
  });
});
