import { describe, expect, it } from 'vitest';
import {
  findCapViolations,
  percentile,
  fairnessVerdict,
  bucketClaimSample,
  planCanSendWithin,
  type LedgerRow,
  type PacingStateRow,
} from './pacing-run.js';

/**
 * pacing-run.test.ts (P26 U5, step 5) - pure tests for the row-based
 * cap-violation detector, percentile math and the M14 fairness verdict. No
 * pg/ioredis/real clock anywhere. The artifact-build/validate/summary tests
 * are the max-lines split sibling `pacing-run-artifact.test.ts` (same 300-
 * line cap that split the production modules themselves).
 */

describe('findCapViolations', () => {
  const state: PacingStateRow[] = [
    {
      instanceId: 'i1',
      clientId: 'c1',
      effDailyCap: 600,
      effHourlyCap: 60,
      effNewConvCap: 600,
      effGroupDailyCap: 50,
    },
  ];

  it('zero_cap_violations_over_a_clean_ledger', () => {
    const ledger: LedgerRow[] = [
      {
        instanceId: 'i1',
        clientId: 'c1',
        ledgerDate: '2026-09-07',
        consumedCount: 600,
        sentThisHour: 60,
        hourKey: 5,
        newConvCount: 10,
        groupSentCount: 50,
      },
    ];
    expect(findCapViolations(ledger, state)).toEqual([]);
  });

  it('a_ledger_row_exceeding_its_daily_cap_is_reported', () => {
    const ledger: LedgerRow[] = [
      {
        instanceId: 'i1',
        clientId: 'c1',
        ledgerDate: '2026-09-07',
        consumedCount: 601,
        sentThisHour: 10,
        hourKey: 5,
        newConvCount: 0,
        groupSentCount: 0,
      },
    ];
    expect(findCapViolations(ledger, state)).toEqual([
      { instanceId: 'i1', kind: 'daily', observed: 601, limit: 600 },
    ]);
  });

  it('a_ledger_row_exceeding_hourly_cap_is_reported', () => {
    const ledger: LedgerRow[] = [
      {
        instanceId: 'i1',
        clientId: 'c1',
        ledgerDate: '2026-09-07',
        consumedCount: 10,
        sentThisHour: 61,
        hourKey: 5,
        newConvCount: 0,
        groupSentCount: 0,
      },
    ];
    expect(findCapViolations(ledger, state)).toEqual([
      { instanceId: 'i1', kind: 'hourly', observed: 61, limit: 60 },
    ]);
  });

  it('a_ledger_row_with_no_matching_state_row_is_an_orphan_ledger_row', () => {
    const ledger: LedgerRow[] = [
      {
        instanceId: 'ghost',
        clientId: 'c1',
        ledgerDate: '2026-09-07',
        consumedCount: 5,
        sentThisHour: 5,
        hourKey: 5,
        newConvCount: 0,
        groupSentCount: 0,
      },
    ];
    expect(findCapViolations(ledger, state)).toEqual([
      { instanceId: 'ghost', kind: 'orphan-ledger-row', observed: 5, limit: -1 },
    ]);
  });

  it('a_client_usage_row_exceeding_its_plan_cap_is_reported', () => {
    const violations = findCapViolations([], [], [{ clientId: 'c1', sentCount: 501, cap: 500 }]);
    expect(violations).toEqual([
      { instanceId: 'c1', kind: 'client-daily', observed: 501, limit: 500 },
    ]);
  });

  it('a_client_usage_row_with_a_null_cap_is_never_a_violation', () => {
    const violations = findCapViolations(
      [],
      [],
      [{ clientId: 'c1', sentCount: 999999, cap: null }],
    );
    expect(violations).toEqual([]);
  });
});

describe('percentile', () => {
  it('computes_exact_p50_p95_p99_over_a_known_dataset', () => {
    // 1..100 - well-known R-7 percentile values.
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBeCloseTo(50.5, 10);
    expect(percentile(values, 95)).toBeCloseTo(95.05, 10);
    expect(percentile(values, 99)).toBeCloseTo(99.01, 10);
  });

  it('p0_and_p100_are_the_min_and_max', () => {
    const values = [7, 3, 9, 1, 5];
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 100)).toBe(9);
  });

  it('a_single_element_array_returns_that_element_for_any_percentile', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it('throws_on_an_empty_array', () => {
    expect(() => percentile([], 50)).toThrow(/empty/);
  });

  it('throws_on_an_out_of_range_percentile', () => {
    expect(() => percentile([1, 2, 3], 101)).toThrow(/\[0, 100\]/);
    expect(() => percentile([1, 2, 3], -1)).toThrow(/\[0, 100\]/);
  });
});

describe('fairnessVerdict', () => {
  it('ratio_within_default_tolerance_is_ok', () => {
    // 47 / 40 = 1.175 < 1.20
    const result = fairnessVerdict({ baselineP99Ms: 40, duringBurstP99Ms: 47 });
    expect(result.ok).toBe(true);
    expect(result.ratio).toBeCloseTo(1.175, 10);
  });

  it('ratio_exceeding_default_tolerance_is_not_ok', () => {
    // 49 / 40 = 1.225 > 1.20
    const result = fairnessVerdict({ baselineP99Ms: 40, duringBurstP99Ms: 49 });
    expect(result.ok).toBe(false);
    expect(result.ratio).toBeCloseTo(1.225, 10);
  });

  it('a_zero_baseline_is_rejected_with_a_named_reason_and_never_divides', () => {
    // Defect 2 (P26 re-smoke): a 0 baseline used to divide to Infinity, which
    // reads as "fairness was measured and failed" when in truth NOTHING was
    // measured in the before-window. It must be a NAMED unmeasured verdict.
    const result = fairnessVerdict({ baselineP99Ms: 0, duringBurstP99Ms: 10 });
    expect(result.ok).toBe(false);
    expect(result.ratio).toBe(null);
    expect(result.note).toBe(
      'fairness not computable: baseline p99 is 0ms - no claim samples in the before window',
    );
  });

  it('a_negative_baseline_is_rejected_with_the_same_named_reason', () => {
    const result = fairnessVerdict({ baselineP99Ms: -1, duringBurstP99Ms: 10 });
    expect(result.ok).toBe(false);
    expect(result.ratio).toBe(null);
    expect(result.note).toBe(
      'fairness not computable: baseline p99 is -1ms - no claim samples in the before window',
    );
  });

  it('a_custom_tolerance_is_respected', () => {
    const result = fairnessVerdict({ baselineP99Ms: 100, duringBurstP99Ms: 105, tolerance: 0.02 });
    expect(result.ok).toBe(false);
    expect(result.ratio).toBeCloseTo(1.05, 10);
  });
});

describe('bucketClaimSample', () => {
  // Defect 1 (P26 re-smoke): the sampler compared `Date.now()` against a
  // RUN-RELATIVE `burstAtSeconds * 1000`, so every sample landed in the
  // during-bucket. Bucketing is now this pure helper over ABSOLUTE instants.
  const t0 = 1_757_000_000_000;
  const burstAtMs = t0 + 30_000;

  it('a_sample_10s_after_t0_with_burst_at_30s_is_before_and_50s_is_during', () => {
    expect(bucketClaimSample(t0 + 10_000, burstAtMs)).toBe('before');
    expect(bucketClaimSample(t0 + 50_000, burstAtMs)).toBe('during');
  });

  it('a_sample_exactly_at_the_burst_instant_is_during', () => {
    expect(bucketClaimSample(burstAtMs, burstAtMs)).toBe('during');
  });

  it('a_run_relative_offset_mistaken_for_an_absolute_instant_buckets_everything_during', () => {
    // 30_000 is the OLD buggy comparand: an absolute-epoch sample always
    // exceeds it, which is exactly how before=0/during=237 happened.
    expect(bucketClaimSample(t0 + 10_000, 30_000)).toBe('during');
  });
});

describe('planCanSendWithin', () => {
  // Defect 3 (P26 re-smoke): a 2-minute run against a heavy class whose
  // per-instance interval is 144s enqueues NOTHING, and `jobs.enqueued=0`
  // then looks like a mis-scoped query. The runner must REFUSE to start.
  it('a_120s_run_against_a_144s_heaviest_interval_cannot_send_and_names_both_numbers', () => {
    const result = planCanSendWithin([{ key: 'heavy', intervalMs: 144_000 }], 120_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(
      'no tenant class can send even once within the run: the fastest class "heavy" sends every ' +
        '144s but the run is only 120s - raise --minutes to at least 3, or lower the mix send rate',
    );
  });

  it('a_360s_run_against_the_same_144s_interval_can_send_and_has_no_reason', () => {
    expect(planCanSendWithin([{ key: 'heavy', intervalMs: 144_000 }], 360_000)).toEqual({
      ok: true,
      reason: null,
    });
  });

  it('the_fastest_class_decides_even_when_a_slower_class_cannot_send', () => {
    expect(
      planCanSendWithin(
        [
          { key: 'heavy', intervalMs: 144_000 },
          { key: 'small', intervalMs: 720_000 },
        ],
        150_000,
      ),
    ).toEqual({ ok: true, reason: null });
  });

  it('an_empty_plan_is_refused_with_a_named_reason', () => {
    const result = planCanSendWithin([], 120_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(
      'no tenant class can send even once within the run: the plan is empty',
    );
  });
});
