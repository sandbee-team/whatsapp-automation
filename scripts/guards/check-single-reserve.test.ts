import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runCheckSingleReserve,
  scanBannedIdentifier,
  scanSingleReserve,
  SINGLE_RESERVE_EXEMPT_PATHS,
} from '../check-single-reserve.js';
import type { SourceFile } from './single-reserve-lib.js';
import { REPO_ROOT } from './registry.js';

/**
 * Fixture proof for check-single-reserve.ts (P13 Unit U3, step 5) - mirrors
 * check-single-claim.test.ts's structure exactly: `scanSingleReserve` is a
 * pure function over already-read source text, so every case here feeds it
 * one fixture file from `__fixtures__/single-reserve/` - never touching the
 * real filesystem scan directly (the real-tree assertion at the bottom of
 * this file, and `pnpm exec tsx scripts/check-single-reserve.ts` run by
 * hand, exercise `runCheckSingleReserve`/the CLI entry point end to end).
 */

function readFixture(name: string): SourceFile {
  const relativePath = `scripts/guards/__fixtures__/single-reserve/${name}`;
  return {
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  };
}

function violatesFixture(name: string): boolean {
  const file = readFixture(name);
  return scanSingleReserve([file], SINGLE_RESERVE_EXEMPT_PATHS).length > 0;
}

describe('check-single-reserve - the four pacing_ledger counter columns have exactly two writers', () => {
  describe('a second statement touching a tracked counter column fails the guard', () => {
    it('a_second_statement_touching_consumed_count_fails_the_guard', () => {
      expect(violatesFixture('bad-second-reserve.sql')).toBe(true);
    });

    it('the_same_shape_against_a_different_tracked_column_also_fails', () => {
      expect(violatesFixture('bad-second-reserve-other-column.sql')).toBe(true);
    });

    it('a_ts_template_literal_second_reserve_still_flags', () => {
      expect(violatesFixture('bad-second-reserve.ts')).toBe(true);
    });

    it('drizzle_second_reserve_shapes_still_flag', () => {
      expect(violatesFixture('bad-drizzle-reserve.ts')).toBe(true);
      expect(violatesFixture('bad-drizzle-reserve-split-builder.ts')).toBe(true);
    });
  });

  describe('a WHERE-clause read of a tracked column, never a write, stays clean', () => {
    it('a_conditional_predicate_reading_consumed_count_stays_clean', () => {
      expect(violatesFixture('clean-where-predicate.sql')).toBe(false);
    });
  });

  describe('pre-existing clean fixtures remain clean', () => {
    it('clean_ts_stays_clean', () => {
      expect(violatesFixture('clean.ts')).toBe(false);
    });

    it('clean_drizzle_ts_stays_clean', () => {
      expect(violatesFixture('clean-drizzle.ts')).toBe(false);
    });
  });

  it('the_two_exempt_paths_are_never_flagged_regardless_of_content', () => {
    // Built via concatenation, never as one contiguous literal: this file
    // is itself scanned by this same guard (scripts/**/*.ts is in
    // SINGLE_RESERVE_GLOBS) - a literal 'UPDATE ... SET consumed_count =
    // ...' string here would trip this guard's own whole-file scan, the
    // same self-referential trap check-single-claim.test.ts documents for
    // its own exempt-path test.
    const reserveSql =
      'UPDATE pacing_ledger SET ' +
      'consumed_count' +
      ' = consumed_count + 1 WHERE instance_id = $1;';
    const releaseSql =
      'UPDATE pacing_ledger SET ' +
      'group_sent_count' +
      ' = group_sent_count - 1 WHERE instance_id = $1;';
    const reserveFile: SourceFile = {
      path: SINGLE_RESERVE_EXEMPT_PATHS[0] as string,
      content: reserveSql,
    };
    const releaseFile: SourceFile = {
      path: SINGLE_RESERVE_EXEMPT_PATHS[1] as string,
      content: releaseSql,
    };
    expect(scanSingleReserve([reserveFile], SINGLE_RESERVE_EXEMPT_PATHS)).toHaveLength(0);
    expect(scanSingleReserve([releaseFile], SINGLE_RESERVE_EXEMPT_PATHS)).toHaveLength(0);
  });
});

describe('check-single-reserve - banned identifier ban', () => {
  it('a_planted_occurrence_of_the_banned_identifier_fails_the_guard', () => {
    const file = readFixture('bad-banned-identifier.ts');
    expect(scanBannedIdentifier([file])).not.toHaveLength(0);
  });

  it('legitimate_gap_related_names_that_are_not_the_banned_identifier_stay_clean', () => {
    const file = readFixture('clean-no-banned-identifier.ts');
    expect(scanBannedIdentifier([file])).toHaveLength(0);
  });
});

describe('check-single-reserve - real repo tree', () => {
  it('the_real_repo_tree_reports_a_non_zero_matched_file_count', () => {
    // This guard's own globs must match at least one real file - a guard
    // matching zero files is not a guard (SESSION-PROTOCOL C4), asserted
    // independently of guards:meta here so a regression in this guard's
    // own globs fails THIS test, not just the meta-assertion.
    const result = runCheckSingleReserve();
    expect(result.filesScanned ?? 0).toBeGreaterThan(0);
  });
});
