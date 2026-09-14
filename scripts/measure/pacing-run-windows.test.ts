import { describe, expect, it } from 'vitest';
import { buildPacingRunArtifact, type PacingRunArtifact } from './pacing-run-artifact.js';
import { validatePacingRunArtifact, formatPacingRunSummary } from './pacing-run-verify.js';

/**
 * pacing-run-windows.test.ts (P26 U5, re-smoke fixes) - max-lines split off
 * `pacing-run-artifact.test.ts` (same idiom as the production modules): the
 * fairness-WINDOW rules found by the first real 200-instance smoke - an
 * empty window is `null` + a NAMED problem (never 0, never an Infinity
 * ratio), and `run.standUpSeconds` is reported apart from the drive window.
 */

function baseHardware() {
  return {
    cpuModel: 'test-cpu',
    cpuCount: 4,
    totalMemBytes: 16_000_000_000,
    kernel: 'test',
    cgroupVersion: 2,
  };
}

function baseArtifact(
  overrides: Partial<PacingRunArtifact> = {},
): Omit<PacingRunArtifact, 'verdict' | 'problems' | 'notes'> & { notes?: string[] } {
  return {
    schemaVersion: 1,
    kind: 'pacing-run',
    capturedAtIso: '2026-09-07T00:00:00.000Z',
    hardware: baseHardware(),
    node: 'v24.20.0',
    run: { plannedSeconds: 3600, measuredSeconds: 3600, instances: 1000, workers: 10, tenants: 3 },
    connection: { viaPgBouncer: true, poolMode: 'transaction', label: 'THROUGH-PGBOUNCER' },
    reserveLatency: { samples: 1000, p50Ms: 3, p95Ms: 10, p99Ms: 15, maxMs: 20, sloMs: 25 },
    capViolations: [],
    jobs: {
      enqueued: 100,
      driverEnqueued: 100,
      ledgerRowCount: 12,
      sent: 90,
      stillQueued: 5,
      terminalFailed: 3,
      blockedNeedsReview: 1,
      cancelled: 1,
      duplicateAckedAttempts: 0,
    },
    burst: null,
    orphanReservations: { measurable: false, reason: 'no v1 detector (RUNBOOK#deferred-alerts)' },
    ...overrides,
  };
}

describe('burst fairness windows - null (unmeasured) handling', () => {
  // Defect 2 (P26 re-smoke): an empty fairness window must be NAMED, never a
  // fabricated `0` p99 and never an `Infinity` ratio.
  it('an_empty_before_window_is_null_with_a_named_problem_and_never_zero', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        burst: {
          recipients: 2000,
          startedAtMs: 180_000,
          otherTenantsClaimP99BeforeMs: null,
          otherTenantsClaimP99DuringMs: 10,
          samplesBefore: 0,
          samplesDuring: 237,
          fairness: { ok: false, ratio: null },
        },
      }),
    );
    expect(artifact.verdict).toBe('FAIL');
    expect(artifact.problems).toContain('no claim samples in the before window');
    expect(artifact.burst?.otherTenantsClaimP99BeforeMs).toBe(null);
    expect(artifact.problems.some((p) => p.includes('Infinity'))).toBe(false);
  });

  it('an_empty_during_window_is_null_with_its_own_named_problem', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        burst: {
          recipients: 2000,
          startedAtMs: 180_000,
          otherTenantsClaimP99BeforeMs: 8,
          otherTenantsClaimP99DuringMs: null,
          samplesBefore: 120,
          samplesDuring: 0,
          fairness: { ok: false, ratio: null },
        },
      }),
    );
    expect(artifact.verdict).toBe('FAIL');
    expect(artifact.problems).toContain('no claim samples in the during window');
  });

  it('both_windows_populated_with_an_ok_ratio_passes_and_records_both_sample_counts', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        burst: {
          recipients: 2000,
          startedAtMs: 180_000,
          otherTenantsClaimP99BeforeMs: 8,
          otherTenantsClaimP99DuringMs: 9,
          samplesBefore: 120,
          samplesDuring: 117,
          fairness: { ok: true, ratio: 1.125 },
        },
      }),
    );
    expect(artifact.verdict).toBe('PASS');
    expect(artifact.problems).toEqual([]);
    expect(artifact.burst?.samplesBefore).toBe(120);
    expect(artifact.burst?.samplesDuring).toBe(117);
  });

  it('a_null_window_artifact_is_FAIL_under_verify_too', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        burst: {
          recipients: 2000,
          startedAtMs: 180_000,
          otherTenantsClaimP99BeforeMs: null,
          otherTenantsClaimP99DuringMs: 10,
          samplesBefore: 0,
          samplesDuring: 237,
          fairness: { ok: false, ratio: null },
        },
      }),
    );
    const result = validatePacingRunArtifact(artifact);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('no claim samples in the before window');
  });

  it('the_summary_prints_null_windows_and_sample_counts_without_an_Infinity_ratio', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        burst: {
          recipients: 2000,
          startedAtMs: 180_000,
          otherTenantsClaimP99BeforeMs: null,
          otherTenantsClaimP99DuringMs: 10,
          samplesBefore: 0,
          samplesDuring: 237,
          fairness: { ok: false, ratio: null },
        },
      }),
    );
    const summary = formatPacingRunSummary(artifact);
    expect(summary).toContain(
      '  burst: 2000 recipients at 180000ms (run-relative) - other-tenant claim p99 ' +
        'before=NOT MEASURED (0 samples) during=10ms (237 samples) fairness=FAIL (ratio not computable)',
    );
    expect(summary).not.toContain('Infinity');
  });
});

describe('vacuous-PASS detection - CRITICAL 2 / MAJOR 3 (C1 fix round FIX-B)', () => {
  it('jobs_sent_zero_fails_with_the_named_vacuous_proof_problem', () => {
    // A run in which nothing is ever claimed must never pass just because
    // every row-based identity is vacuously true over zero rows.
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        jobs: {
          enqueued: 100,
          driverEnqueued: 100,
          ledgerRowCount: 12,
          sent: 0,
          stillQueued: 100,
          terminalFailed: 0,
          blockedNeedsReview: 0,
          cancelled: 0,
          duplicateAckedAttempts: 0,
        },
      }),
    );
    expect(artifact.verdict).toBe('FAIL');
    expect(artifact.problems).toContain('jobs.sent is 0 - nothing was ever claimed');
  });

  it('an_empty_pacing_ledger_fails_with_its_own_named_problem', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        jobs: {
          enqueued: 100,
          driverEnqueued: 100,
          ledgerRowCount: 0,
          sent: 90,
          stillQueued: 5,
          terminalFailed: 3,
          blockedNeedsReview: 1,
          cancelled: 1,
          duplicateAckedAttempts: 0,
        },
      }),
    );
    expect(artifact.verdict).toBe('FAIL');
    expect(artifact.problems).toContain('pacing_ledger has 0 rows for the fleet');
  });

  it('a_PASS_alongside_any_named_problem_is_never_reported_as_PASS', () => {
    // Belt-and-suspenders: `collectProblems` is the sole verdict authority,
    // so a rule firing always flips `buildPacingRunArtifact`'s own verdict -
    // there is no code path that lets a problem coexist with PASS.
    const artifact = buildPacingRunArtifact(
      baseArtifact({
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
      }),
    );
    expect(artifact.verdict).toBe('FAIL');
    expect(artifact.problems).toContain('jobs.sent is 0 - nothing was ever claimed');
    expect(artifact.problems).toContain('pacing_ledger has 0 rows for the fleet');
  });
});

describe('run.standUpSeconds - defect 6 (drive window vs fleet stand-up)', () => {
  it('stand_up_seconds_is_carried_separately_and_printed_next_to_the_measured_drive_window', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        run: {
          plannedSeconds: 360,
          measuredSeconds: 361.2,
          standUpSeconds: 105.3,
          instances: 200,
          workers: 4,
          tenants: 3,
        },
      }),
    );
    expect(artifact.verdict).toBe('PASS');
    expect(artifact.run.standUpSeconds).toBe(105.3);
    expect(formatPacingRunSummary(artifact)).toContain(
      'planned 360s, measured 361.2s (drive window; fleet stand-up 105.3s)',
    );
  });
});
