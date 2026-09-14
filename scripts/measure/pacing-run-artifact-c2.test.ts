import { describe, expect, it } from 'vitest';
import { buildPacingRunArtifact, type PacingRunArtifact } from './pacing-run-artifact.js';

/**
 * pacing-run-artifact-c2.test.ts (P26 C2) - max-lines split off
 * `pacing-run-artifact.test.ts` (established idiom - `session-worker-
 * discovery-wiring.ts`): the vacuous-PASS detectors (`jobs.sent === 0`,
 * `jobs.ledgerRowCount === 0`, empty burst before/during windows) that the
 * source documents as CRITICAL findings but the original test file never
 * exercised.
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

describe('buildPacingRunArtifact - vacuous-PASS detectors (C2)', () => {
  it('jobs_sent_zero_fails_as_a_vacuous_pass_even_when_everything_else_balances', () => {
    // Coverage gap (C2): documented as CRITICAL "vacuous-PASS detection" in
    // the source, but never exercised - a run where nothing was ever claimed
    // still satisfies every row-based identity trivially (0 == 0).
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        jobs: {
          enqueued: 0,
          driverEnqueued: 0,
          ledgerRowCount: 12,
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
    expect(artifact.problems.some((p) => p.includes('jobs.sent is 0'))).toBe(true);
  });

  it('ledger_row_count_zero_fails_even_when_sends_and_conservation_look_clean', () => {
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
    expect(artifact.problems.some((p) => p.includes('pacing_ledger has 0 rows'))).toBe(true);
  });

  it('an_empty_before_window_in_a_burst_fails_even_though_fairness_ok_is_true', () => {
    // "no claim samples in the before window" must fire on its own - a
    // fairness.ok defaulted to true over zero samples must never read as a
    // measured pass (same vacuous-window class as jobs.sent === 0).
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        burst: {
          recipients: 100_000,
          startedAtMs: 1_800_000,
          otherTenantsClaimP99BeforeMs: null,
          otherTenantsClaimP99DuringMs: 49,
          samplesBefore: 0,
          samplesDuring: 280,
          fairness: { ok: true, ratio: null },
        },
      }),
    );
    expect(artifact.verdict).toBe('FAIL');
    expect(artifact.problems.some((p) => p.includes('before window'))).toBe(true);
  });

  it('an_empty_during_window_in_a_burst_fails_even_though_fairness_ok_is_true', () => {
    const artifact = buildPacingRunArtifact(
      baseArtifact({
        burst: {
          recipients: 100_000,
          startedAtMs: 1_800_000,
          otherTenantsClaimP99BeforeMs: 40,
          otherTenantsClaimP99DuringMs: null,
          samplesBefore: 300,
          samplesDuring: 0,
          fairness: { ok: true, ratio: null },
        },
      }),
    );
    expect(artifact.verdict).toBe('FAIL');
    expect(artifact.problems.some((p) => p.includes('during window'))).toBe(true);
  });
});
