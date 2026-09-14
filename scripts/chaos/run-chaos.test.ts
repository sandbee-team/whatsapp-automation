import { describe, expect, test } from 'vitest';
import {
  FLUSHABLE_TARGETS,
  ForbiddenFlushTargetError,
  assertFlushTargetAllowed,
  deployWaveSize,
  CHAOS_SCENARIOS,
  validateChaosRunRecord,
  formatChaosRunMarkdown,
  type ChaosRunRecord,
} from './run-chaos.js';

/**
 * run-chaos.test.ts (P26 U6b, step 6) - the PURE half of the chaos harness:
 * flush-target refusal (ADR 0018 S5), the deploy-wave-size SLO formula, the
 * chaos scenario registry, and the run-record schema validator/formatter. No
 * pg/ioredis/app-backend import here - see `scale-fleet.test.ts`'s own
 * header for the same process-boundary reasoning (scripts/ cannot import
 * app/backend).
 */

describe('FLUSHABLE_TARGETS / assertFlushTargetAllowed', () => {
  test('redis_ctl_is_the_only_flushable_target', () => {
    expect(FLUSHABLE_TARGETS).toEqual(['redis-ctl']);
  });

  test('redis_ctl_does_not_throw', () => {
    expect(() => assertFlushTargetAllowed('redis-ctl')).not.toThrow();
  });

  test('redis_sig_throws_forbidden_flush_target_error_naming_the_consequence', () => {
    expect(() => assertFlushTargetAllowed('redis-sig')).toThrow(ForbiddenFlushTargetError);
    try {
      assertFlushTargetAllowed('redis-sig');
      expect.unreachable('assertFlushTargetAllowed should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenFlushTargetError);
      const message = (err as Error).message;
      expect(message).toContain('redis-sig');
      expect(message).toContain('0018');
      expect(message.toLowerCase()).toMatch(/permanently unreadable/);
    }
  });

  test('every_other_target_also_throws', () => {
    expect(() => assertFlushTargetAllowed('redis-cache')).toThrow(ForbiddenFlushTargetError);
    expect(() => assertFlushTargetAllowed('all')).toThrow(ForbiddenFlushTargetError);
    expect(() => assertFlushTargetAllowed('postgres')).toThrow(ForbiddenFlushTargetError);
    expect(() => assertFlushTargetAllowed('nonsense')).toThrow(ForbiddenFlushTargetError);
  });

  test('case_and_whitespace_variants_of_the_allowed_target_are_refused_not_normalized (C2)', () => {
    // Exact-match only, by design: a case/whitespace-tolerant comparison
    // here would be a silent gate-widening on the one destructive op this
    // module exists to restrict.
    expect(() => assertFlushTargetAllowed('REDIS-CTL')).toThrow(ForbiddenFlushTargetError);
    expect(() => assertFlushTargetAllowed('Redis-Ctl')).toThrow(ForbiddenFlushTargetError);
    expect(() => assertFlushTargetAllowed('redis-ctl ')).toThrow(ForbiddenFlushTargetError);
    expect(() => assertFlushTargetAllowed(' redis-ctl')).toThrow(ForbiddenFlushTargetError);
    expect(() => assertFlushTargetAllowed('')).toThrow(ForbiddenFlushTargetError);
  });
});

describe('deployWaveSize', () => {
  test('exact_slo_derived_formula', () => {
    // max(1, floor(fleetSessions * fraction / sessionsPerWorker))
    expect(deployWaveSize({ fleetSessions: 10_000, sessionsPerWorker: 100, fraction: 0.02 })).toBe(
      2,
    );
    expect(deployWaveSize({ fleetSessions: 1_000, sessionsPerWorker: 100, fraction: 0.02 })).toBe(
      1,
    );
  });

  test('default_fraction_is_two_percent', () => {
    expect(deployWaveSize({ fleetSessions: 10_000, sessionsPerWorker: 50 })).toBe(4);
  });

  test('never_below_one', () => {
    expect(deployWaveSize({ fleetSessions: 1, sessionsPerWorker: 1000, fraction: 0.02 })).toBe(1);
  });

  test('throws_named_error_on_non_positive_sessions_per_worker', () => {
    expect(() => deployWaveSize({ fleetSessions: 100, sessionsPerWorker: 0 })).toThrow(
      /sessionsPerWorker/,
    );
    expect(() => deployWaveSize({ fleetSessions: 100, sessionsPerWorker: -1 })).toThrow(
      /sessionsPerWorker/,
    );
  });

  test('fleet_size_and_sessions_per_worker_boundaries_0_1_49_50_51 (C2)', () => {
    // max(1, floor(fleetSessions * fraction / sessionsPerWorker)), fraction default 0.02.
    expect(deployWaveSize({ fleetSessions: 0, sessionsPerWorker: 50 })).toBe(1);
    expect(deployWaveSize({ fleetSessions: 1, sessionsPerWorker: 50 })).toBe(1);
    // 49 * 0.02 / 50 = 0.0196 -> floor 0 -> max(1, 0) = 1
    expect(deployWaveSize({ fleetSessions: 49, sessionsPerWorker: 50 })).toBe(1);
    // 50 * 0.02 / 50 = 0.02 -> floor 0 -> max(1, 0) = 1
    expect(deployWaveSize({ fleetSessions: 50, sessionsPerWorker: 50 })).toBe(1);
    expect(deployWaveSize({ fleetSessions: 51, sessionsPerWorker: 50 })).toBe(1);
    // Crossover to 2 requires fleetSessions * 0.02 / 50 >= 2, i.e. fleetSessions >= 5000.
    expect(deployWaveSize({ fleetSessions: 4_999, sessionsPerWorker: 50 })).toBe(1);
    expect(deployWaveSize({ fleetSessions: 5_000, sessionsPerWorker: 50 })).toBe(2);
  });
});

describe('CHAOS_SCENARIOS', () => {
  test('contains_exactly_the_four_named_scenarios', () => {
    expect(CHAOS_SCENARIOS).toEqual([
      'worker-kill',
      'redis-flush',
      'postgres-outage',
      'rolling-deploy',
    ]);
  });
});

function baseRecord(overrides: Partial<ChaosRunRecord> = {}): ChaosRunRecord {
  return {
    schemaVersion: 1,
    kind: 'chaos',
    scenario: 'worker-kill',
    capturedAtIso: '2026-09-07T00:00:00.000Z',
    fleet: { instances: 24, workers: 3, sessionsPerWorker: 8 },
    measurements: { maxTakeoverMs: 12_345 },
    sloTargets: { maxTakeoverMs: '<= 45000' },
    verdict: 'PASS',
    problems: [],
    notes: [],
    ...overrides,
  };
}

describe('validateChaosRunRecord', () => {
  test('valid_record_is_ok', () => {
    expect(validateChaosRunRecord(baseRecord())).toEqual({ ok: true, problems: [] });
  });

  test('null_measurement_without_a_note_is_a_problem', () => {
    const record = baseRecord({ measurements: { bucketSpend: null } });
    const result = validateChaosRunRecord(record);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('bucketSpend'))).toBe(true);
  });

  test('null_measurement_with_a_note_is_allowed', () => {
    const record = baseRecord({
      measurements: { bucketSpend: null },
      notes: ['bucketSpend: unobservable at fleet scale - see test doc comment'],
    });
    expect(validateChaosRunRecord(record)).toEqual({ ok: true, problems: [] });
  });

  test('pass_verdict_with_nonempty_problems_is_itself_a_problem', () => {
    const record = baseRecord({ verdict: 'PASS', problems: ['something is off'] });
    const result = validateChaosRunRecord(record);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => /verdict.*PASS/i.test(p))).toBe(true);
  });

  test('scenario_outside_the_registry_is_a_problem', () => {
    const record = baseRecord({ scenario: 'not-a-scenario' as ChaosRunRecord['scenario'] });
    const result = validateChaosRunRecord(record);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('scenario'))).toBe(true);
  });

  test('empty_measurements_object_is_a_problem', () => {
    const record = baseRecord({ measurements: {} });
    const result = validateChaosRunRecord(record);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => /measurements/i.test(p))).toBe(true);
  });

  test('non_object_input_is_a_problem_never_throws', () => {
    expect(validateChaosRunRecord(null).ok).toBe(false);
    expect(validateChaosRunRecord(42).ok).toBe(false);
    expect(() => validateChaosRunRecord(undefined)).not.toThrow();
  });
});

describe('formatChaosRunMarkdown', () => {
  test('includes_scenario_verdict_and_every_measurement', () => {
    const md = formatChaosRunMarkdown(baseRecord());
    expect(md).toContain('worker-kill');
    expect(md).toContain('PASS');
    expect(md).toContain('maxTakeoverMs');
    expect(md).toContain('12345');
  });
});
