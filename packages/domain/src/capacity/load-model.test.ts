import { describe, expect, it } from 'vitest';
import {
  loadModel,
  projectDailyGrowth,
  UnpublishableLoadModelError,
  InvalidLoadModelWindowError,
  InvalidLoadModelDeltaError,
} from './load-model.js';

// NOTE on the "literal 12" source-scan assertion described in the task:
// `.dependency-cruiser.cjs`'s `domain-must-be-pure-core` / `-npm` rules scope
// `from: { path: '^packages/domain/src/' } }` with NO exclusion for
// `*.test.ts` files (the "not tests/" comment on that rule refers to the
// separate `packages/domain/tests/` directory, outside `src/`, not to
// `.test.ts` files living inside `src/`). A `node:fs` + `import.meta.dirname`
// read of this module's own source from THIS file would therefore itself
// trip `domain-must-be-pure-core` (a Node builtin import under
// `packages/domain/src/`). Per the task's own branch instruction, the
// source-scan assertion is skipped here rather than breaking depcruise; the
// "no constant 12" contract is instead enforced by the exact-value fixtures
// below (A: 7.5, B: 13.2 - both distinct from 12).
describe('load model', () => {
  it('statements_per_send_is_a_measured_delta_not_a_constant', () => {
    const modelA = loadModel({
      sendCount: 1000,
      statementDelta: 7_500,
      relationSizeDeltaBytes: 0,
      walBytes: 0,
      windowSeconds: 60,
    });
    expect(modelA.statementsPerSend).toBe(7.5);
    expect(modelA.statementsPerSend).not.toBe(12);

    const modelB = loadModel({
      sendCount: 400,
      statementDelta: 5_280,
      relationSizeDeltaBytes: 0,
      walBytes: 0,
      windowSeconds: 60,
    });
    expect(modelB.statementsPerSend).toBe(13.2);
    expect(modelB.statementsPerSend).not.toBe(12);
  });

  it('bytes_per_send_projects_daily_growth_at_a_given_fleet_size', () => {
    const windowSeconds = 3600;
    const model = loadModel({
      sendCount: 100_000,
      statementDelta: 0,
      relationSizeDeltaBytes: 250_000_000,
      walBytes: 0,
      windowSeconds,
    });
    expect(model.bytesPerSend).toBe(2500);

    const projection = projectDailyGrowth(model, {
      connected: 10_000,
      sendsPerDayPerInstance: 600,
    });

    expect(projection.bytesPerDay).toBe(15_000_000_000);
    expect(projection.gbPerDay).toBeCloseTo(13.97, 2);
    expect(projection.sampleSize).toEqual({ sendCount: 100_000, windowSeconds });
  });

  it('a_result_without_a_sample_size_cannot_be_published', () => {
    expect(() =>
      loadModel({
        sendCount: 0,
        statementDelta: 100,
        relationSizeDeltaBytes: 0,
        walBytes: 0,
        windowSeconds: 60,
      }),
    ).toThrow(UnpublishableLoadModelError);

    expect(() =>
      loadModel({
        sendCount: 100,
        statementDelta: 100,
        relationSizeDeltaBytes: 0,
        walBytes: 0,
        windowSeconds: 0,
      }),
    ).toThrow(InvalidLoadModelWindowError);
  });

  it('wal_mb_per_sec_is_exact_for_a_fixture', () => {
    const model = loadModel({
      sendCount: 10,
      statementDelta: 0,
      relationSizeDeltaBytes: 0,
      walBytes: 6_291_456,
      windowSeconds: 60,
    });
    expect(model.walMbPerSec).toBeCloseTo(0.1, 10);
  });

  it('a_non_finite_statement_delta_throws_rather_than_publishing_NaN_or_Infinity (bug fix)', () => {
    // REAL DEFECT (found in C2): before the fix, a NaN/Infinity delta from a
    // glitched pg_stat_statements/pg_total_relation_size/WAL read silently
    // propagated into the published ratio instead of throwing, exactly the
    // outcome this module's OWN header says sendCount's validation exists to
    // prevent - just missing on the numerator side.
    expect(() =>
      loadModel({
        sendCount: 100,
        statementDelta: Number.NaN,
        relationSizeDeltaBytes: 0,
        walBytes: 0,
        windowSeconds: 60,
      }),
    ).toThrow(InvalidLoadModelDeltaError);

    expect(() =>
      loadModel({
        sendCount: 100,
        statementDelta: 10,
        relationSizeDeltaBytes: Number.POSITIVE_INFINITY,
        walBytes: 0,
        windowSeconds: 60,
      }),
    ).toThrow(InvalidLoadModelDeltaError);

    expect(() =>
      loadModel({
        sendCount: 100,
        statementDelta: 10,
        relationSizeDeltaBytes: 0,
        walBytes: Number.NEGATIVE_INFINITY,
        windowSeconds: 60,
      }),
    ).toThrow(InvalidLoadModelDeltaError);
  });

  it('a_negative_but_finite_relation_size_delta_is_accepted (net shrink is a real measurement, not an error)', () => {
    // Mirrors pg-load-validate.ts's own `relationSizeBytes < 0` handling: a
    // finite negative delta is a legitimate "net shrink over the window"
    // fact, never rejected the way a non-finite value is.
    const model = loadModel({
      sendCount: 100,
      statementDelta: 10,
      relationSizeDeltaBytes: -5_000,
      walBytes: 0,
      windowSeconds: 60,
    });
    expect(model.bytesPerSend).toBe(-50);
  });

  it('negative_connected_throws_in_project_daily_growth', () => {
    const model = loadModel({
      sendCount: 100,
      statementDelta: 100,
      relationSizeDeltaBytes: 0,
      walBytes: 0,
      windowSeconds: 60,
    });
    expect(() => projectDailyGrowth(model, { connected: -1, sendsPerDayPerInstance: 1 })).toThrow();
  });
});
