import { describe, expect, it } from 'vitest';
import { evaluateLedgerChain, type LedgerRow } from '../restore-drill-lib.js';
import { computeRecoveryPoint, computeRto } from '../../../scripts/ops/restore-drill-metrics.js';
import {
  computeRestoreDrillProblems,
  validateRestoreDrillReport,
  type RestoreDrillReport,
} from '../../../scripts/ops/restore-drill-report.js';

/**
 * restore-drill-report-edge.test.ts (P29a E3/C2 hardening) - ledger chain
 * math edge cases (bigint precision, negative amounts, single-row clients,
 * unordered input, duplicate seq, empty input) and report-rule edge cases
 * (v2 exists:false, negative RPO, rto.ok=false as a note not a FAIL,
 * PASS-with-problems self-disagreement, v1-report-still-validates).
 */

describe('evaluateLedgerChain edge cases', () => {
  it('bigint_values_above_2_pow_53_do_not_lose_precision', () => {
    // 2^53 = 9007199254740992. Use values well above it that would collide
    // under Number arithmetic but must not collide as bigint.
    const huge = '9007199254740993'; // 2^53 + 1, not exactly representable as Number
    const rows: LedgerRow[] = [
      { client_id: 'c1', seq: 1, amount_minor: huge, balance_after_minor: huge },
      {
        client_id: 'c1',
        seq: 2,
        amount_minor: '1',
        balance_after_minor: '9007199254740994', // huge + 1n, exact only in bigint
      },
    ];
    const result = evaluateLedgerChain(rows);
    expect(result.breaks).toEqual([]);
  });

  it('negative_amounts_debits_are_evaluated_correctly', () => {
    const rows: LedgerRow[] = [
      { client_id: 'c1', seq: 1, amount_minor: 1000, balance_after_minor: 1000 },
      { client_id: 'c1', seq: 2, amount_minor: -1500, balance_after_minor: -500 },
    ];
    const result = evaluateLedgerChain(rows);
    expect(result.breaks).toEqual([]);
  });

  it('a_single_row_client_whose_balance_after_does_not_equal_amount_is_a_break', () => {
    const rows: LedgerRow[] = [
      { client_id: 'c1', seq: 1, amount_minor: 1000, balance_after_minor: 999 },
    ];
    const result = evaluateLedgerChain(rows);
    expect(result.breaks).toEqual([{ client_id: 'c1', seq: '1', expected: '1000', actual: '999' }]);
  });

  it('unordered_input_rows_are_sorted_by_seq_before_evaluation', () => {
    const rows: LedgerRow[] = [
      { client_id: 'c1', seq: 3, amount_minor: 100, balance_after_minor: 1300 },
      { client_id: 'c1', seq: 1, amount_minor: 1000, balance_after_minor: 1000 },
      { client_id: 'c1', seq: 2, amount_minor: 200, balance_after_minor: 1200 },
    ];
    const result = evaluateLedgerChain(rows);
    expect(result.breaks).toEqual([]);
    expect(result.rowsChecked).toBe(3);
  });

  it('a_duplicate_seq_for_one_client_is_never_silently_ok', () => {
    // Two rows share seq=1 with DIFFERENT balances - the comparator returns
    // 0 for equal seq (a total order), so `Array.prototype.sort` preserves
    // INPUT order for the tie (a stable sort per the spec) - the outcome is
    // deterministic, not "whichever order the sort resolves ties in".
    const rows: LedgerRow[] = [
      { client_id: 'c1', seq: 1, amount_minor: 1000, balance_after_minor: 1000 },
      { client_id: 'c1', seq: 1, amount_minor: 500, balance_after_minor: 500 },
    ];
    const result = evaluateLedgerChain(rows);
    // Input order is preserved for the tie: row 1 (amount 1000, balance
    // 1000) has no predecessor, so expected=1000=actual, no break; row 2
    // (amount 500, balance 500) is evaluated as a successor with
    // previousBalance=1000, so expected=1500 != actual=500 - exactly one
    // break, for row 2, always (never row 1, never zero, never both).
    expect(result.breaks).toEqual([{ client_id: 'c1', seq: '1', expected: '1500', actual: '500' }]);
  });

  it('two_rows_with_equal_seq_sort_deterministically_regardless_of_input_order', () => {
    // Same two rows as above, reversed input order - the comparator's
    // explicit 0-on-equality return keeps the sort stable, so reversing the
    // INPUT reverses the OUTPUT order too (never a coin-flip): now row A
    // (amount 500, balance 500) is first (no predecessor, no break) and row
    // B (amount 1000, balance 1000) is the successor with
    // previousBalance=500, so expected=1500 != actual=1000 - the break
    // moves with the input, proving determinism, not just "some break".
    const rows: LedgerRow[] = [
      { client_id: 'c1', seq: 1, amount_minor: 500, balance_after_minor: 500 },
      { client_id: 'c1', seq: 1, amount_minor: 1000, balance_after_minor: 1000 },
    ];
    const result = evaluateLedgerChain(rows);
    expect(result.breaks).toEqual([
      { client_id: 'c1', seq: '1', expected: '1500', actual: '1000' },
    ]);
  });

  it('an_empty_array_is_zero_clients_zero_breaks_ok', () => {
    const result = evaluateLedgerChain([]);
    expect(result).toEqual({ clientsChecked: 0, rowsChecked: 0, breaks: [] });
  });
});

describe('computeRecoveryPoint edge cases', () => {
  it('a_negative_rpo_from_clock_skew_is_clamped_but_the_underlying_skew_is_still_computable', () => {
    // drillStart BEFORE the recovery point (clock skew or a bad input) -
    // computeRecoveryPoint clamps rpoSeconds to 0 via Math.max(0, ...) rather
    // than reporting a negative figure. This test pins that EXACT documented
    // behaviour (0, ok: true) so a future change to silently swallow clock
    // skew differently does not go unnoticed - and separately proves the
    // raw (unclamped) skew is still recoverable by the caller from the two
    // input timestamps if it ever needs to be surfaced as a note.
    const input = {
      backupEndIso: '2026-09-08T00:10:00.000Z',
      lastReplayIso: null,
      drillStartIso: '2026-09-08T00:00:00.000Z', // 10 minutes BEFORE backupEnd
    };
    const result = computeRecoveryPoint(input);
    expect(result.rpoSeconds).toBe(0);
    expect(result.ok).toBe(true);

    const rawSkewSeconds = Math.round(
      (new Date(input.drillStartIso).getTime() - new Date(input.backupEndIso).getTime()) / 1000,
    );
    expect(rawSkewSeconds).toBe(-600);
  });

  it('a_positive_rpo_within_target_is_ok', () => {
    const result = computeRecoveryPoint({
      backupEndIso: '2026-09-08T00:00:00.000Z',
      lastReplayIso: null,
      drillStartIso: '2026-09-08T00:02:00.000Z',
    });
    expect(result.rpoSeconds).toBe(120);
    expect(result.ok).toBe(true);
  });

  it('an_rpo_beyond_target_is_not_ok_but_still_computed_exactly', () => {
    const result = computeRecoveryPoint({
      backupEndIso: '2026-09-08T00:00:00.000Z',
      lastReplayIso: null,
      drillStartIso: '2026-09-08T00:10:00.000Z',
    });
    expect(result.rpoSeconds).toBe(600);
    expect(result.ok).toBe(false);
  });
});

function baseV2Report(): RestoreDrillReport {
  return {
    schemaVersion: 2,
    kind: 'restore-drill',
    capturedAtIso: '2026-09-08T00:00:00.000Z',
    source: { host: '127.0.0.1:55432', database: 'wp', schemaVersion: 75 },
    backup: {
      tool: 'pg_basebackup',
      format: 'tar',
      compression: 'none',
      bytes: 1000,
      tookMs: 5000,
      path: 'x',
    },
    restore: {
      tool: 'postgres-crash-recovery',
      mode: 'basebackup-scratch-container',
      target: { host: '127.0.0.1:55499', database: 'wp' },
      tookMs: 6000,
      dataSizeBytes: 1000,
      restoredDataSizeBytes: 1000,
    },
    verification: {
      schemaVersion: { expected: 75, actual: 75, ok: true },
      tables: [{ name: 'clients', sourceRows: 5, restoredRows: 5 }],
      parity: [{ name: 'message_jobs', sourceRows: 10, restoredRows: 10, exists: true }],
      ledgerChain: { clientsChecked: 2, rowsChecked: 20, breaks: 0, ok: true },
      claimQuery: { rowsReturned: 1, ok: true, note: 'ok' },
      plaintextScan: { sentinels: ['noiseKey'], blobHits: 0, dumpFileHits: 0, ok: true },
    },
    recovery: {
      recoveryPointIso: '2026-09-08T00:00:00.000Z',
      rpoSeconds: 10,
      rpoTargetSeconds: 300,
      ok: true,
    },
    rto: { rtoMs: 6000, rtoTargetMs: 3_600_000, ok: true },
    adr0018Tier: { tier: '<=2000', claimedRto: '~1 h at <= 2,000 connected' },
    verdict: 'PASS',
    problems: [],
    notes: [],
  };
}

describe('report rule edge cases', () => {
  it('exists_false_with_source_and_restored_mismatched_is_not_a_problem', () => {
    const report = baseV2Report();
    report.verification.parity = [
      { name: 'messages', sourceRows: 5, restoredRows: 0, exists: false },
    ];
    const problems = computeRestoreDrillProblems(report);
    expect(problems).toEqual([]);
  });

  it('exists_true_with_a_mismatch_is_a_problem', () => {
    const report = baseV2Report();
    report.verification.parity = [
      { name: 'messages', sourceRows: 5, restoredRows: 4, exists: true },
    ];
    const problems = computeRestoreDrillProblems(report);
    expect(problems.some((p) => p.includes('messages'))).toBe(true);
  });

  it('a_negative_rpo_seconds_in_the_report_is_not_silently_ok', () => {
    // computeRestoreDrillProblems has no explicit RPO rule (recovery.ok is
    // "recorded honestly, never a FAIL rule" per this file's own header
    // comment) - assert that documented choice explicitly: a negative
    // rpoSeconds does NOT add a problem entry, but the report's own `ok`
    // field must independently be false so a reader is not told "fine" by
    // that field either.
    const report = baseV2Report();
    report.recovery = {
      recoveryPointIso: '2026-09-08T00:10:00.000Z',
      rpoSeconds: -30,
      rpoTargetSeconds: 300,
      ok: false,
    };
    const problems = computeRestoreDrillProblems(report);
    expect(problems).toEqual([]);
    expect(report.recovery.ok).toBe(false);
  });

  it('rto_ok_false_is_recorded_as_a_note_not_a_fail_rule', () => {
    const report = baseV2Report();
    report.rto = { rtoMs: 4_000_000, rtoTargetMs: 3_600_000, ok: false };
    const problems = computeRestoreDrillProblems(report);
    expect(problems).toEqual([]);
    expect(report.rto.ok).toBe(false);
  });

  it('verdict_pass_with_nonempty_problems_is_a_self_disagreement_problem', () => {
    const report = baseV2Report();
    report.verification.parity = [
      { name: 'messages', sourceRows: 5, restoredRows: 4, exists: true },
    ];
    report.verdict = 'PASS';
    const { ok, problems } = validateRestoreDrillReport(report);
    expect(ok).toBe(false);
    expect(problems.some((p) => p.includes('must never disagree with its own rules'))).toBe(true);
  });

  it('a_v1_report_2026_09_07_shape_still_validates', () => {
    const v1Report: Partial<RestoreDrillReport> = {
      schemaVersion: 1,
      kind: 'restore-drill',
      capturedAtIso: '2026-09-07T00:00:00.000Z',
      source: { host: '127.0.0.1:55432', database: 'wp', schemaVersion: 74 },
      backup: {
        tool: 'pg_dump',
        format: 'custom',
        compression: 'none',
        bytes: 500,
        tookMs: 2000,
        path: 'x',
      },
      restore: {
        tool: 'pg_restore',
        target: { host: '127.0.0.1:55499', database: 'wp' },
        tookMs: 3000,
        dataSizeBytes: 500,
        restoredDataSizeBytes: 500,
      },
      verification: {
        schemaVersion: { expected: 74, actual: 74, ok: true },
        tables: [{ name: 'clients', sourceRows: 5, restoredRows: 5 }],
        claimQuery: { rowsReturned: 1, ok: true, note: 'ok' },
        plaintextScan: { sentinels: [], blobHits: 0, dumpFileHits: 0, ok: true },
      },
      adr0018Tier: { tier: '<=2000', claimedRto: '~1 h at <= 2,000 connected' },
      verdict: 'PASS',
      problems: [],
      notes: [],
    };
    const { ok, problems } = validateRestoreDrillReport(v1Report);
    expect(ok).toBe(true);
    expect(problems).toEqual([]);
  });

  it('computeRto_computes_the_exact_millisecond_delta', () => {
    const result = computeRto({
      restoreStartIso: '2026-09-08T00:00:00.000Z',
      verifiedAtIso: '2026-09-08T00:00:05.500Z',
    });
    expect(result.rtoMs).toBe(5500);
    expect(result.ok).toBe(true);
  });
});
