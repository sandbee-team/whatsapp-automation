import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanSingleClaim, SINGLE_CLAIM_EXEMPT_PATH } from '../check-single-claim.js';
import type { SourceFile } from './single-claim-lib.js';
import { REPO_ROOT } from './registry.js';

/**
 * Fixture proof for check-single-claim.ts (P09 debugger fix).
 *
 * `scanSingleClaim` is a pure function over already-read source text, so
 * every case here feeds it one fixture file from
 * `__fixtures__/single-claim/` - never touching the real filesystem scan
 * (`runCheckSingleClaim`/`readSourceFiles` are exercised end to end by
 * `npx tsx scripts/check-single-claim.ts` instead, see `cli-smoke.test.ts`).
 *
 * Root cause pinned here (P09): LITERAL_STATUS_PATTERN and
 * PARAMETERIZED_STATUS_PATTERN used an unbounded `[^;]*?` gap between `SET`
 * and the `status = 'processing'` / `status = $param` target, which could
 * cross a `WHERE` keyword and match a WHERE-clause predicate as if it were
 * a SET-clause assignment (drain.ts's `markNeedsReconcile`: `SET status =
 * 'needs_reconcile', ... WHERE ... status = 'processing'` is a legitimate
 * conditional-transition guard, not a second claim). Fixed by bounding the
 * gap with `(?:(?!\bWHERE\b)[^;])*?` so it can never cross into a WHERE
 * clause. Every case below is a `readFixture` call against a checked-in
 * fixture, run through the library function - no fixture content is
 * inlined here, so drift between this file and the fixture on disk cannot
 * silently happen.
 */

function readFixture(name: string): SourceFile {
  const relativePath = `scripts/guards/__fixtures__/single-claim/${name}`;
  return {
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  };
}

function violatesFixture(name: string): boolean {
  const file = readFixture(name);
  return scanSingleClaim([file], SINGLE_CLAIM_EXEMPT_PATH).length > 0;
}

describe('check-single-claim (P09 debugger fix - SET vs WHERE clause blindness)', () => {
  describe('WHERE-clause predicates using status = processing must never flag (the bug)', () => {
    it('a_conditional_transition_update_matching_drain_ts_markneedsreconcile_shape_stays_clean_sql', () => {
      expect(violatesFixture('clean-where-predicate.sql')).toBe(false);
    });

    it('the_same_shape_as_a_ts_template_literal_stays_clean', () => {
      expect(violatesFixture('clean-where-predicate.ts')).toBe(false);
    });

    it('a_parameterized_where_predicate_status_equals_dollar_status_also_stays_clean', () => {
      // Both functions live in the same fixture file; scanSingleClaim scans
      // the whole file's literal spans, so a violation from either function
      // would show up in the same result set.
      expect(violatesFixture('clean-where-predicate.ts')).toBe(false);
    });
  });

  describe('detection strength is preserved - a real SET-clause write of processing still flags', () => {
    it('the_original_flagged_shape_bad_claim_sql_still_flags', () => {
      expect(violatesFixture('bad-claim.sql')).toBe(true);
    });

    it('a_multiline_set_list_with_an_extra_assignment_before_status_still_flags', () => {
      expect(violatesFixture('bad-claim-sneaky-shapes.sql')).toBe(true);
    });

    it('no_space_around_the_equals_sign_still_flags', () => {
      // bad-claim-sneaky-shapes.sql also covers status='processing' (no
      // spaces) - already asserted true above; this case adds the
      // upper/mixed-case keyword variant.
      expect(violatesFixture('bad-claim-mixed-case.sql')).toBe(true);
    });

    it('lowercase_sql_keywords_still_flag', () => {
      expect(violatesFixture('bad-lowercase-claim.sql')).toBe(true);
    });

    it('a_named_parameter_bind_still_flags', () => {
      expect(violatesFixture('bad-named-param-claim.sql')).toBe(true);
    });

    it('a_positional_parameter_bind_still_flags', () => {
      expect(violatesFixture('bad-parameterized-claim.sql')).toBe(true);
    });

    it('a_semicolon_inside_a_comment_between_update_and_set_still_flags', () => {
      expect(violatesFixture('bad-claim-semicolon-in-comment.sql')).toBe(true);
    });

    it('a_second_claim_ts_template_literal_still_flags', () => {
      expect(violatesFixture('bad-second-claim.ts')).toBe(true);
    });

    it('a_semicolon_inside_an_unrelated_string_value_still_flags', () => {
      expect(violatesFixture('bad-second-claim-semicolon-in-string.ts')).toBe(true);
    });

    it('a_parameterized_ts_second_claim_still_flags', () => {
      expect(violatesFixture('bad-parameterized-claim.ts')).toBe(true);
    });

    it('drizzle_second_claim_shapes_still_flag', () => {
      expect(violatesFixture('bad-drizzle-claim.ts')).toBe(true);
      expect(violatesFixture('bad-drizzle-claim-nested-object.ts')).toBe(true);
      expect(violatesFixture('bad-drizzle-claim-split-builder.ts')).toBe(true);
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

  it('the_exempt_path_itself_is_never_flagged_regardless_of_content', () => {
    // Built via concatenation, never as one contiguous literal: this file
    // is itself scanned by this same guard (`scripts/**/*.ts` is in
    // SINGLE_CLAIM_GLOBS) - a literal 'UPDATE ... SET status = ...
    // processing ...' string here would trip this guard's own whole-file
    // scan, the same self-referential trap this module's header comment
    // documents for DRIZZLE_UPDATE_SET_STATUS_PATTERN.
    const claimSql =
      'UPDATE message_jobs SET status = ' +
      "'" +
      'processing' +
      "'" +
      " WHERE id = $1 AND status = 'queued';";
    const exempt: SourceFile = {
      path: SINGLE_CLAIM_EXEMPT_PATH,
      content: claimSql,
    };
    expect(scanSingleClaim([exempt], SINGLE_CLAIM_EXEMPT_PATH)).toHaveLength(0);
  });
});
