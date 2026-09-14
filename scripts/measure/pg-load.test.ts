import { describe, expect, it } from 'vitest';
import {
  diffSnapshots,
  buildPgLoadArtifact,
  UnpublishableLoadModelError,
  type PgSnapshot,
} from './pg-load.js';
import { validatePgLoadArtifact, formatPgLoadSummary } from './pg-load-validate.js';

/**
 * pg-load.test.ts (P26 Unit U4, step 4) - pure unit tests over the
 * `pg_stat_statements`/relation-size/WAL delta arithmetic, the artifact
 * schema/validator, and the summary formatter. No real Postgres - every
 * snapshot here is a fixture. Additional edge-case + derived-literal-
 * isolation tests live in the sibling `pg-load-validate.test.ts` (300-line
 * cap split).
 */

const HARDWARE = {
  cpuModel: 'AMD EPYC 7413',
  cpuCount: 12,
  totalMemBytes: 16_000_000_000,
  kernel: '5.15.0',
  cgroupVersion: 2,
};

function snapshot(overrides: Partial<PgSnapshot> = {}): PgSnapshot {
  return {
    atMs: 0,
    statementsTotal: 0,
    relationSizesBytes: {},
    walBytes: 0,
    pgBouncer: null,
    pacingConsumed: 0,
    ...overrides,
  };
}

describe('diffSnapshots + buildPgLoadArtifact', () => {
  it('statements_per_send_comes_from_the_measured_delta', () => {
    const before = snapshot({ atMs: 0, statementsTotal: 1_000_000 });
    const after = snapshot({ atMs: 100_000, statementsTotal: 1_750_000 });
    const delta = diffSnapshots(before, after);

    const artifact = buildPgLoadArtifact({
      capturedAtIso: '2026-09-07T00:00:00.000Z',
      hardware: HARDWARE,
      node: 'v24.20.0',
      viaPgBouncer: true,
      window: { startMs: 0, endMs: 100_000 },
      sends: { attempted: 100_000, observed: 100_000 },
      delta,
      projectAt: [],
      baseline: null,
      concurrentNote: 'none declared',
      drain: { complete: true, pendingAtEnd: 0, pendingSample: [] },
      notes: ['--baseline-seconds 0 was explicitly passed - no idle baseline was sampled'],
    });

    expect(artifact.measured.statementsPerSend).toBe(7.5);
    expect(artifact.derivedComparison.statementsPerSendDerived).toBe(12);
    expect(artifact.derivedComparison.agreement).toContain('12');
  });

  it('durable_bytes_per_send_uses_the_summed_per_table_delta', () => {
    const before = snapshot({
      atMs: 0,
      relationSizesBytes: {
        message_jobs: 1_000_000_000,
        delivery_events: 500_000_000,
        pacing_ledger: 10_000_000,
      },
    });
    const after = snapshot({
      atMs: 100_000,
      relationSizesBytes: {
        message_jobs: 1_200_000_000,
        delivery_events: 550_000_000,
        pacing_ledger: 9_000_000,
      },
    });
    const delta = diffSnapshots(before, after);

    expect(delta.relationSizeBytes).toBe(249_000_000);
    expect(delta.perTableBytes.pacing_ledger).toBe(-1_000_000);

    const artifact = buildPgLoadArtifact({
      capturedAtIso: '2026-09-07T00:00:00.000Z',
      hardware: HARDWARE,
      node: 'v24.20.0',
      viaPgBouncer: true,
      window: { startMs: 0, endMs: 100_000 },
      sends: { attempted: 100_000, observed: 100_000 },
      delta,
      projectAt: [],
      baseline: null,
      concurrentNote: 'none declared',
      drain: { complete: true, pendingAtEnd: 0, pendingSample: [] },
      notes: ['--baseline-seconds 0 was explicitly passed - no idle baseline was sampled'],
    });

    expect(artifact.measured.bytesPerSend).toBe(2490);
    expect(artifact.deltas.perTableBytes.pacing_ledger).toBe(-1_000_000);
  });

  it('a_zero_statement_delta_is_a_named_problem_not_a_zero_result', () => {
    const before = snapshot({ atMs: 0, statementsTotal: 500_000 });
    const after = snapshot({ atMs: 100_000, statementsTotal: 500_000 });
    const delta = diffSnapshots(before, after);

    const artifact = buildPgLoadArtifact({
      capturedAtIso: '2026-09-07T00:00:00.000Z',
      hardware: HARDWARE,
      node: 'v24.20.0',
      viaPgBouncer: true,
      window: { startMs: 0, endMs: 100_000 },
      sends: { attempted: 1000, observed: 1000 },
      delta,
      projectAt: [],
      baseline: null,
      concurrentNote: 'none declared',
      drain: { complete: true, pendingAtEnd: 0, pendingSample: [] },
      notes: ['--baseline-seconds 0 was explicitly passed - no idle baseline was sampled'],
    });

    const { ok, problems } = validatePgLoadArtifact(artifact);
    expect(ok).toBe(false);
    expect(problems.some((p) => p.toLowerCase().includes('pg_stat_statements'))).toBe(true);
  });

  it('a_direct_connection_run_must_say_so', () => {
    const before = snapshot({ atMs: 0, statementsTotal: 0 });
    const after = snapshot({ atMs: 100_000, statementsTotal: 1000 });
    const delta = diffSnapshots(before, after);

    const withoutNote = buildPgLoadArtifact({
      capturedAtIso: '2026-09-07T00:00:00.000Z',
      hardware: HARDWARE,
      node: 'v24.20.0',
      viaPgBouncer: false,
      window: { startMs: 0, endMs: 100_000 },
      sends: { attempted: 100, observed: 100 },
      delta,
      projectAt: [],
      baseline: null,
      concurrentNote: 'none declared',
      drain: { complete: true, pendingAtEnd: 0, pendingSample: [] },
    });
    expect(validatePgLoadArtifact(withoutNote).ok).toBe(false);
    expect(
      validatePgLoadArtifact(withoutNote).problems.some((p) => p.includes('DIRECT-CONNECTION')),
    ).toBe(true);

    const withNote = buildPgLoadArtifact({
      capturedAtIso: '2026-09-07T00:00:00.000Z',
      hardware: HARDWARE,
      node: 'v24.20.0',
      viaPgBouncer: false,
      window: { startMs: 0, endMs: 100_000 },
      sends: { attempted: 100, observed: 100 },
      delta,
      projectAt: [],
      baseline: null,
      concurrentNote: 'none declared',
      drain: { complete: true, pendingAtEnd: 0, pendingSample: [] },
      notes: [
        'DIRECT-CONNECTION: PgBouncer admin connection unavailable on this host',
        '--baseline-seconds 0 was explicitly passed - no idle baseline was sampled',
      ],
    });
    expect(validatePgLoadArtifact(withNote).ok).toBe(true);
  });

  it('projection_scales_the_measured_bytes_to_a_fleet_size', () => {
    const before = snapshot({ atMs: 0, relationSizesBytes: { message_jobs: 0 } });
    const after = snapshot({ atMs: 100_000, relationSizesBytes: { message_jobs: 249_000_000 } });
    const delta = diffSnapshots(before, after);

    const artifact = buildPgLoadArtifact({
      capturedAtIso: '2026-09-07T00:00:00.000Z',
      hardware: HARDWARE,
      node: 'v24.20.0',
      viaPgBouncer: true,
      window: { startMs: 0, endMs: 100_000 },
      sends: { attempted: 100_000, observed: 100_000 },
      delta,
      projectAt: [
        { connected: 1000, sendsPerDayPerInstance: 600 },
        { connected: 10_000, sendsPerDayPerInstance: 600 },
      ],
      baseline: null,
      concurrentNote: 'none declared',
      drain: { complete: true, pendingAtEnd: 0, pendingSample: [] },
      notes: ['--baseline-seconds 0 was explicitly passed - no idle baseline was sampled'],
    });

    expect(artifact.measured.bytesPerSend).toBe(2490);
    expect(artifact.projected[0]?.bytesPerDay).toBe(1_494_000_000);
    expect(artifact.projected[1]?.bytesPerDay).toBe(14_940_000_000);
  });

  it('an_artifact_without_a_sample_size_cannot_be_built', () => {
    const before = snapshot({ atMs: 0 });
    const after = snapshot({ atMs: 100_000 });
    const delta = diffSnapshots(before, after);

    expect(() =>
      buildPgLoadArtifact({
        capturedAtIso: '2026-09-07T00:00:00.000Z',
        hardware: HARDWARE,
        node: 'v24.20.0',
        viaPgBouncer: true,
        window: { startMs: 0, endMs: 100_000 },
        sends: { attempted: 0, observed: 0 },
        delta,
        projectAt: [],
        baseline: null,
        concurrentNote: 'none declared',
        drain: { complete: true, pendingAtEnd: 0, pendingSample: [] },
      }),
    ).toThrow(UnpublishableLoadModelError);
  });
});

describe('formatPgLoadSummary', () => {
  it('formats a human-readable summary including the derived comparison', () => {
    const before = snapshot({
      atMs: 0,
      statementsTotal: 0,
      relationSizesBytes: { message_jobs: 0 },
    });
    const after = snapshot({
      atMs: 100_000,
      statementsTotal: 1_200_000,
      relationSizesBytes: { message_jobs: 249_000_000 },
    });
    const delta = diffSnapshots(before, after);
    const artifact = buildPgLoadArtifact({
      capturedAtIso: '2026-09-07T00:00:00.000Z',
      hardware: HARDWARE,
      node: 'v24.20.0',
      viaPgBouncer: true,
      window: { startMs: 0, endMs: 100_000 },
      sends: { attempted: 100_000, observed: 100_000 },
      delta,
      projectAt: [{ connected: 1000, sendsPerDayPerInstance: 600 }],
      baseline: null,
      concurrentNote: 'none declared',
      drain: { complete: true, pendingAtEnd: 0, pendingSample: [] },
      notes: ['--baseline-seconds 0 was explicitly passed - no idle baseline was sampled'],
    });

    const summary = formatPgLoadSummary(artifact);
    expect(summary).toContain('pg-load measurement');
    expect(summary).toContain('vs ADR 0018 section 7 derived');
    expect(summary).toContain('projected @ 1000 connected');
  });
});
