import { describe, expect, it } from 'vitest';
import { diffSnapshots, buildPgLoadArtifact, type PgSnapshot } from './pg-load.js';
import { validatePgLoadArtifact } from './pg-load-validate.js';

/**
 * pg-load-baseline.test.ts (P26 C1 fix round, FIX-C MAJOR 5) - the idle-
 * baseline subtraction tests, split out of `pg-load.test.ts` purely for the
 * 300-line cap (established idiom - `pg-load-validate.test.ts`).
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

describe('baseline subtraction (P26 C1 fix round, FIX-C MAJOR 5)', () => {
  it('subtracts_the_idle_baseline_share_from_the_drive_window_delta_with_an_exact_value', () => {
    const before = snapshot({
      atMs: 0,
      statementsTotal: 1_000_000,
      relationSizesBytes: { message_jobs: 1_000_000_000 },
      walBytes: 0,
    });
    // Drive window: 100s. Raw deltas: 750,000 statements, 249,000,000 bytes, 100,000,000 WAL bytes.
    const after = snapshot({
      atMs: 100_000,
      statementsTotal: 1_750_000,
      relationSizesBytes: { message_jobs: 1_249_000_000 },
      walBytes: 100_000_000,
    });
    const delta = diffSnapshots(before, after);

    // Baseline sampled idle for 60s: 6,000 statements, 6,000,000 bytes, 6,000,000 WAL bytes
    // => 100 statements/sec, 100,000 bytes/sec relation growth, 100,000 bytes/sec WAL.
    const baseline = {
      statementsPerSec: 100,
      relationBytesPerSec: 100_000,
      walBytesPerSec: 100_000,
      seconds: 60,
    };

    const artifact = buildPgLoadArtifact({
      capturedAtIso: '2026-09-07T00:00:00.000Z',
      hardware: HARDWARE,
      node: 'v24.20.0',
      viaPgBouncer: true,
      window: { startMs: 0, endMs: 100_000 },
      sends: { attempted: 100_000, observed: 100_000 },
      delta,
      projectAt: [],
      baseline,
      concurrentNote: 'none declared',
      drain: { complete: true, pendingAtEnd: 0, pendingSample: [] },
    });

    // Over the 100s drive window, baseline share = rate * 100s.
    // statements: 750,000 - 100*100 = 740,000
    // relationSizeBytes: 249,000,000 - 100,000*100 = 239,000,000
    // walBytes: 100,000,000 - 100,000*100 = 90,000,000
    expect(artifact.deltas.baselineSubtracted?.statements).toBe(740_000);
    expect(artifact.deltas.baselineSubtracted?.relationSizeBytes).toBe(239_000_000);
    expect(artifact.deltas.baselineSubtracted?.walBytes).toBe(90_000_000);
    expect(artifact.baseline).toEqual(baseline);
  });

  it('a_missing_baseline_is_a_named_problem_unless_baseline_seconds_0_was_passed_and_noted', () => {
    const before = snapshot({ atMs: 0, statementsTotal: 0 });
    const after = snapshot({ atMs: 100_000, statementsTotal: 1000 });
    const delta = diffSnapshots(before, after);

    const withoutBaselineOrNote = buildPgLoadArtifact({
      capturedAtIso: '2026-09-07T00:00:00.000Z',
      hardware: HARDWARE,
      node: 'v24.20.0',
      viaPgBouncer: true,
      window: { startMs: 0, endMs: 100_000 },
      sends: { attempted: 100, observed: 100 },
      delta,
      projectAt: [],
      baseline: null,
      concurrentNote: 'none declared',
      drain: { complete: true, pendingAtEnd: 0, pendingSample: [] },
    });
    const result = validatePgLoadArtifact(withoutBaselineOrNote);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('baseline'))).toBe(true);

    const withExplicitSkipNote = buildPgLoadArtifact({
      capturedAtIso: '2026-09-07T00:00:00.000Z',
      hardware: HARDWARE,
      node: 'v24.20.0',
      viaPgBouncer: true,
      window: { startMs: 0, endMs: 100_000 },
      sends: { attempted: 100, observed: 100 },
      delta,
      projectAt: [],
      baseline: null,
      concurrentNote: 'none declared',
      drain: { complete: true, pendingAtEnd: 0, pendingSample: [] },
      notes: ['--baseline-seconds 0 was explicitly passed - no idle baseline was sampled'],
    });
    expect(validatePgLoadArtifact(withExplicitSkipNote).ok).toBe(true);
  });

  it('records the concurrent-load note verbatim', () => {
    const before = snapshot({ atMs: 0, statementsTotal: 0 });
    const after = snapshot({ atMs: 100_000, statementsTotal: 1000 });
    const delta = diffSnapshots(before, after);
    const artifact = buildPgLoadArtifact({
      capturedAtIso: '2026-09-07T00:00:00.000Z',
      hardware: HARDWARE,
      node: 'v24.20.0',
      viaPgBouncer: true,
      window: { startMs: 0, endMs: 100_000 },
      sends: { attempted: 100, observed: 100 },
      delta,
      projectAt: [],
      baseline: { statementsPerSec: 0, relationBytesPerSec: 0, walBytesPerSec: 0, seconds: 60 },
      concurrentNote: 'wp-p26-drift 7-day run, ~1000 sessions',
      drain: { complete: true, pendingAtEnd: 0, pendingSample: [] },
    });
    expect(artifact.notes.some((n) => n.includes('wp-p26-drift 7-day run'))).toBe(true);
  });
});
