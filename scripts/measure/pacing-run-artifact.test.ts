import { describe, expect, it } from 'vitest';
import { buildPacingRunArtifact, type PacingRunArtifact } from './pacing-run-artifact.js';
import { validatePacingRunArtifact, formatPacingRunSummary } from './pacing-run-verify.js';

/**
 * pacing-run-artifact.test.ts (P26 U5, step 5) - pure tests for
 * `buildPacingRunArtifact`, `validatePacingRunArtifact` and
 * `formatPacingRunSummary`. Max-lines split off `pacing-run.test.ts` (same
 * idiom as the production module split - see `pacing-run-artifact.ts`'s own
 * header).
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

describe('buildPacingRunArtifact + validatePacingRunArtifact', () => {
  it('a_clean_input_yields_verdict_PASS_and_zero_problems', () => {
    const artifact = buildPacingRunArtifact(baseArtifact());
    expect(artifact.verdict).toBe('PASS');
    expect(artifact.problems).toEqual([]);
    expect(validatePacingRunArtifact(artifact)).toEqual({ ok: true, problems: [] });
  });

  it('any_cap_violation_fails_the_verdict', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        capViolations: [{ instanceId: 'i1', kind: 'daily', observed: 601, limit: 600 }],
      }),
    );
    expect(artifact.verdict).toBe('FAIL');
    expect(artifact.problems).toContain('1 cap violation(s) found (see capViolations)');
  });

  it('reserve_p99_at_or_above_25ms_fails', () => {
    const at = buildPacingRunArtifact(
      baseArtifact({
        reserveLatency: { samples: 100, p50Ms: 1, p95Ms: 20, p99Ms: 25, maxMs: 30, sloMs: 25 },
      }),
    );
    expect(at.verdict).toBe('FAIL');
    expect(at.problems.some((p) => p.includes('reserveLatency.p99Ms'))).toBe(true);

    const over = buildPacingRunArtifact(
      baseArtifact({
        reserveLatency: { samples: 100, p50Ms: 1, p95Ms: 20, p99Ms: 26.1, maxMs: 30, sloMs: 25 },
      }),
    );
    expect(over.verdict).toBe('FAIL');

    const under = buildPacingRunArtifact(
      baseArtifact({
        reserveLatency: { samples: 100, p50Ms: 1, p95Ms: 20, p99Ms: 24.9, maxMs: 30, sloMs: 25 },
      }),
    );
    expect(under.verdict).toBe('PASS');
  });

  it('zero_reserve_latency_samples_fails', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        reserveLatency: { samples: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, sloMs: 25 },
      }),
    );
    expect(artifact.verdict).toBe('FAIL');
    expect(artifact.problems.some((p) => p.includes('samples is 0'))).toBe(true);
  });

  it('broken_job_conservation_fails', () => {
    // Conservation compares the DRIVER's own enqueue count against the
    // row-based bucket sum - a row-sum-vs-itself comparison is always true
    // and was the exact vacuous-PASS shape CRITICAL 2(c) named.
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        jobs: {
          enqueued: 100,
          driverEnqueued: 101,
          ledgerRowCount: 12,
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
    expect(artifact.problems.some((p) => p.includes('job conservation broken'))).toBe(true);
  });

  it('duplicate_acked_attempts_fails', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        jobs: {
          enqueued: 100,
          driverEnqueued: 100,
          ledgerRowCount: 12,
          sent: 90,
          stillQueued: 5,
          terminalFailed: 3,
          blockedNeedsReview: 1,
          cancelled: 1,
          duplicateAckedAttempts: 2,
        },
      }),
    );
    expect(artifact.verdict).toBe('FAIL');
    expect(artifact.problems.some((p) => p.includes('duplicateAckedAttempts is 2'))).toBe(true);
  });

  it('a_failing_burst_fairness_fails_the_whole_artifact', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        burst: {
          recipients: 100_000,
          startedAtMs: 1_800_000,
          otherTenantsClaimP99BeforeMs: 40,
          otherTenantsClaimP99DuringMs: 49,
          samplesBefore: 300,
          samplesDuring: 280,
          fairness: { ok: false, ratio: 1.225 },
        },
      }),
    );
    expect(artifact.verdict).toBe('FAIL');
    expect(artifact.problems.some((p) => p.includes('burst fairness failed'))).toBe(true);
  });

  it('zero_or_negative_measured_seconds_fails', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        run: { plannedSeconds: 3600, measuredSeconds: 0, instances: 1000, workers: 10, tenants: 3 },
      }),
    );
    expect(artifact.verdict).toBe('FAIL');
    expect(artifact.problems.some((p) => p.includes('run.measuredSeconds'))).toBe(true);
  });

  it('a_direct_connection_label_adds_a_note_but_never_fails_on_its_own', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        connection: { viaPgBouncer: false, poolMode: null, label: 'DIRECT-CONNECTION' },
      }),
    );
    expect(artifact.verdict).toBe('PASS');
    expect(artifact.notes.some((n) => n.includes('DIRECT'))).toBe(true);
  });
});

describe('validatePacingRunArtifact - fixture-based (reserve p99 SLO)', () => {
  it('a_fixture_with_p99_24point9_passes', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        reserveLatency: { samples: 500, p50Ms: 2, p95Ms: 10, p99Ms: 24.9, maxMs: 26, sloMs: 25 },
      }),
    );
    expect(validatePacingRunArtifact(artifact)).toEqual({ ok: true, problems: [] });
  });

  it('a_fixture_with_p99_25point0_fails_with_the_named_problem', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        reserveLatency: { samples: 500, p50Ms: 2, p95Ms: 10, p99Ms: 25.0, maxMs: 26, sloMs: 25 },
      }),
    );
    const result = validatePacingRunArtifact(artifact);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('reserveLatency.p99Ms'))).toBe(true);
  });

  it('a_fixture_with_p99_26point1_fails_with_the_named_problem', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        reserveLatency: { samples: 500, p50Ms: 2, p95Ms: 10, p99Ms: 26.1, maxMs: 30, sloMs: 25 },
      }),
    );
    const result = validatePacingRunArtifact(artifact);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('reserveLatency.p99Ms'))).toBe(true);
  });

  it('a_fixture_with_zero_samples_is_a_problem', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        reserveLatency: { samples: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, sloMs: 25 },
      }),
    );
    const result = validatePacingRunArtifact(artifact);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('samples is 0'))).toBe(true);
  });

  it('a_shape_that_does_not_match_the_schema_fails', () => {
    expect(validatePacingRunArtifact({ not: 'an artifact' })).toEqual({
      ok: false,
      problems: ['input does not match the PacingRunArtifact schema'],
    });
  });

  it('a_hand_crafted_PASS_verdict_alongside_a_real_problem_is_itself_a_problem', () => {
    const artifact = buildPacingRunArtifact(baseArtifact());
    const tampered = {
      ...artifact,
      verdict: 'PASS' as const,
      capViolations: [{ instanceId: 'i1', kind: 'daily' as const, observed: 601, limit: 600 }],
    };
    const result = validatePacingRunArtifact(tampered);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('PASS alongside'))).toBe(true);
  });
});

describe('formatPacingRunSummary', () => {
  it('includes_the_verdict_and_key_figures', () => {
    const artifact = buildPacingRunArtifact(baseArtifact());
    const summary = formatPacingRunSummary(artifact);
    expect(summary).toContain('[PASS]');
    expect(summary).toContain('THROUGH-PGBOUNCER');
    expect(summary).toContain('NOT MEASURABLE');
  });
});
