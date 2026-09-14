import { describe, expect, it } from 'vitest';
import {
  idBudgetForRun,
  OrphanAttemptLandmineError,
  seqLowerBoundExclusive,
  seqUpperBoundInclusive,
} from './orphan-attempts-preflight.js';

/**
 * orphan-attempts-preflight.test.ts (FIX-P26-D; FIX-P26-H MINOR h,
 * 2026-09-07) - pure unit tests for `idBudgetForRun` (sends * 2 + instances
 * * 2) and `seqLowerBoundExclusive` (the `is_called`-aware sequence lower
 * bound). Exact values only, never a bound - a bounds-only assertion would
 * pass a wrong implementation, see .claude/rules/core-invariants.md "Units
 * and quantities".
 */
describe('idBudgetForRun', () => {
  it('computes sends * 2 + instances * 2 for a 1k-send, 1k-instance run', () => {
    expect(idBudgetForRun({ sends: 1000, instances: 1000 })).toBe(4000);
  });

  it('computes sends * 2 + instances * 2 for a small run', () => {
    expect(idBudgetForRun({ sends: 100, instances: 5 })).toBe(210);
  });

  it('is exactly 0 for a budget of 0 sends and 0 instances', () => {
    expect(idBudgetForRun({ sends: 0, instances: 0 })).toBe(0);
  });

  it('stays exact at the fixture-floor scale (9e12 + 1e9), well under the bigint-string 2^53 boundary', () => {
    // The preflight reads message_job_id back as a STRING (bigint column) and
    // converts with Number() - this fixture floor is the value named in the
    // C2 brief; it is far below Number.MAX_SAFE_INTEGER (2^53 - 1 =
    // 9,007,199,254,740,991), so idBudgetForRun (a plain multiply/add over
    // ordinary run-sized counts, never over a message_job_id itself) is
    // exact here by construction.
    const sends = 9_000_000_000_000;
    const instances = 1_000_000_000;
    expect(idBudgetForRun({ sends, instances })).toBe(sends * 2 + instances * 2);
    expect(Number.isSafeInteger(idBudgetForRun({ sends, instances }))).toBe(true);
  });
});

describe('seqLowerBoundExclusive (MINOR h fix)', () => {
  it('a never-called sequence (is_called=false) reports last_value - 1, since last_value itself is still about to be issued', () => {
    expect(seqLowerBoundExclusive({ lastValue: 1, isCalled: false })).toBe(0);
  });

  it('a called sequence (is_called=true) reports last_value unchanged - it has already been issued', () => {
    expect(seqLowerBoundExclusive({ lastValue: 10, isCalled: true })).toBe(10);
  });
});

describe('seqUpperBoundInclusive (MINOR 1 fix)', () => {
  it('adds idBudget to the RAW last_value, matching the SQL upper bound exactly', () => {
    expect(seqUpperBoundInclusive({ lastValue: 1 }, 100)).toBe(101);
    expect(seqUpperBoundInclusive({ lastValue: 10 }, 100)).toBe(110);
  });
});

describe('OrphanAttemptLandmineError window text (MINOR 1 fix)', () => {
  it('prints (0, 101] for a never-called sequence, matching the raw-last_value-based SQL scan exactly', () => {
    const message = new OrphanAttemptLandmineError({
      seqLastValue: seqLowerBoundExclusive({ lastValue: 1, isCalled: false }),
      seqLastValueRaw: 1,
      idBudget: 100,
      count: 1,
      minJobId: 1,
      maxJobId: 1,
      distinctClients: 1,
    }).message;
    expect(message).toContain('(0, 101]');
  });

  it('prints (10, 110] for a called sequence, unchanged from before the fix', () => {
    const message = new OrphanAttemptLandmineError({
      seqLastValue: seqLowerBoundExclusive({ lastValue: 10, isCalled: true }),
      seqLastValueRaw: 10,
      idBudget: 100,
      count: 1,
      minJobId: 11,
      maxJobId: 11,
      distinctClients: 1,
    }).message;
    expect(message).toContain('(10, 110]');
  });
});
