import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runCheckSingleClaim,
  scanSingleClaim,
  SINGLE_CLAIM_EXEMPT_PATH,
  SINGLE_CLAIM_GLOBS,
} from '../check-single-claim.js';
import { resolveFiles } from '../guards/scan-config.js';
import { REPO_ROOT } from '../guards/registry.js';

/**
 * check-single-claim.ts (P03 Unit B, step 5) - proves the guard flags any
 * `UPDATE ... status = 'processing'` outside `db/queries/claim-jobs.sql`,
 * across both raw `.sql` files and TS/TSX string/template literals, and
 * that the on-disk canon statement itself (the sole exemption) stays clean.
 * `scanSingleClaim` is a pure function over already-read source text -
 * fixtures live under `scripts/guards/__fixtures__/single-claim/` (excluded
 * from the guard's own real repo scan by CONTENT_EXCLUSIONS), matching the
 * fixture convention used by check-tenant-scope.test.ts / check-sql-lint.test.ts.
 */

const FIXTURES_DIR = 'scripts/guards/__fixtures__/single-claim';

function readFixture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, FIXTURES_DIR, name), 'utf8');
}

describe('check-single-claim (P03 Unit B, step 5)', () => {
  it('a_planted_second_claim_update_in_a_ts_file_is_rejected_and_reports_a_non_zero_matched_file_count', () => {
    const filePath = `${FIXTURES_DIR}/bad-second-claim.ts`;
    const files = [{ path: filePath, content: readFixture('bad-second-claim.ts') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((violation) => violation.file === filePath)).toBe(true);
  });

  it('both_the_straight_and_whitespace_quote_variant_are_caught_in_the_same_fixture', () => {
    const filePath = `${FIXTURES_DIR}/bad-second-claim.ts`;
    const files = [{ path: filePath, content: readFixture('bad-second-claim.ts') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    // rogueClaim() (single-quoted, spaced) + rogueClaimVariant() (double-quoted, no space).
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  it('a_planted_second_claim_update_in_a_raw_sql_file_is_rejected', () => {
    const filePath = `${FIXTURES_DIR}/bad-claim.sql`;
    const files = [{ path: filePath, content: readFixture('bad-claim.sql') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });

  it('the_clean_fixture_is_never_flagged', () => {
    const filePath = `${FIXTURES_DIR}/clean.ts`;
    const files = [{ path: filePath, content: readFixture('clean.ts') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations).toEqual([]);
  });

  it('the_real_claim_jobs_sql_file_is_exempt_even_though_it_sets_status_processing', () => {
    const realContent = readFileSync(path.join(REPO_ROOT, SINGLE_CLAIM_EXEMPT_PATH), 'utf8');
    // Sanity: the real file really does contain the pattern this guard bans everywhere else.
    expect(realContent).toMatch(/status='processing'/);

    const violations = scanSingleClaim(
      [{ path: SINGLE_CLAIM_EXEMPT_PATH, content: realContent }],
      SINGLE_CLAIM_EXEMPT_PATH,
    );

    expect(violations).toEqual([]);
  });

  it('the_same_content_at_a_different_path_is_not_exempt', () => {
    const realContent = readFileSync(path.join(REPO_ROOT, SINGLE_CLAIM_EXEMPT_PATH), 'utf8');

    const violations = scanSingleClaim(
      [{ path: 'db/queries/claim-jobs-copy.sql', content: realContent }],
      SINGLE_CLAIM_EXEMPT_PATH,
    );

    expect(violations.length).toBeGreaterThan(0);
  });

  it('an_empty_file_list_flags_nothing', () => {
    expect(scanSingleClaim([], SINGLE_CLAIM_EXEMPT_PATH)).toEqual([]);
  });

  it('the_real_repo_tree_today_has_zero_violations_and_a_non_zero_scanned_count', () => {
    const result = runCheckSingleClaim();

    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  it('resolving_single_claim_globs_actually_returns_files_under_db_tests_and_db_schema', () => {
    // P03 close (re-review round, item 4): the previous version of this test
    // only asserted `SINGLE_CLAIM_GLOBS.toContain(...)` - an array literal
    // proving it contains itself, true by construction and incapable of
    // catching a typo'd glob that matches nothing on disk. Resolving the
    // real globs against the real repo tree and asserting non-empty results
    // under each directory is the actual evidence that db/tests and
    // db/schema are in scan scope.
    const resolved = resolveFiles(SINGLE_CLAIM_GLOBS);

    expect(resolved.some((file) => file.startsWith('db/tests/'))).toBe(true);
    expect(resolved.some((file) => file.startsWith('db/schema/'))).toBe(true);
  });

  it('resolving_single_claim_globs_now_covers_db_tests_sql_fixtures', () => {
    // P03 close, finding 4: db/tests has 4 real .sql fixture files
    // (migration-runner test fixtures) that the module doc claimed were in
    // scan scope but the globs never actually matched - only
    // db/tests/**/*.{ts,tsx} was listed. Same real-resolution proof as
    // above, for the .sql glob specifically.
    const resolved = resolveFiles(SINGLE_CLAIM_GLOBS);

    expect(resolved).toContain('db/tests/fixtures/migrations-basic/0001_widgets.sql');
  });

  it('a_case_insensitive_lowercase_claim_update_in_raw_sql_is_rejected', () => {
    // finding 4c.
    const filePath = `${FIXTURES_DIR}/bad-lowercase-claim.sql`;
    const files = [{ path: filePath, content: readFixture('bad-lowercase-claim.sql') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });

  it('a_parameterized_status_write_bound_in_ts_is_rejected', () => {
    // finding 4b.
    const filePath = `${FIXTURES_DIR}/bad-parameterized-claim.ts`;
    const files = [{ path: filePath, content: readFixture('bad-parameterized-claim.ts') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });

  it('a_parameterized_status_write_in_a_raw_sql_file_is_rejected', () => {
    // P03 close, guard hardening: PARAMETERIZED_STATUS_PATTERN must also
    // catch a raw .sql second-claim UPDATE (now that app/**/*.sql,
    // admin/**/*.sql, infra/**/*.sql are in scan scope too), not just a
    // TS/TSX string/template literal.
    const filePath = `${FIXTURES_DIR}/bad-parameterized-claim.sql`;
    const files = [{ path: filePath, content: readFixture('bad-parameterized-claim.sql') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });

  it('a_named_parameter_status_write_in_a_raw_sql_file_is_rejected', () => {
    // P03 close (re-review round, item 4): PARAMETERIZED_STATUS_PATTERN's
    // numeric-only `$1`-style shape missed a NAMED bind (`status = $status`)
    // - a second, equally real bypass of the literal-text requirement.
    const filePath = `${FIXTURES_DIR}/bad-named-param-claim.sql`;
    const files = [{ path: filePath, content: readFixture('bad-named-param-claim.sql') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });

  it('a_parameterized_update_on_message_jobs_that_never_touches_status_is_never_flagged', () => {
    const filePath = `${FIXTURES_DIR}/clean.ts`;
    const files = [{ path: filePath, content: readFixture('clean.ts') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations).toEqual([]);
  });

  it('a_drizzle_update_messageJobs_set_status_call_is_rejected', () => {
    // finding 4a.
    const filePath = `${FIXTURES_DIR}/bad-drizzle-claim.ts`;
    const files = [{ path: filePath, content: readFixture('bad-drizzle-claim.ts') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });

  it('a_semicolon_inside_an_unrelated_string_literal_does_not_defeat_the_bounded_gap', () => {
    // P03 close, finding 2a: `lease_owner = 'a;b'` between SET and
    // status='processing' must not truncate the [^;]-bounded scan.
    const filePath = `${FIXTURES_DIR}/bad-second-claim-semicolon-in-string.ts`;
    const files = [
      { path: filePath, content: readFixture('bad-second-claim-semicolon-in-string.ts') },
    ];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });

  it('a_semicolon_inside_a_line_comment_does_not_defeat_the_bounded_gap', () => {
    // P03 close, finding 2b: `-- note; here` between UPDATE and SET in a raw
    // .sql file must not truncate the [^;]-bounded scan.
    const filePath = `${FIXTURES_DIR}/bad-claim-semicolon-in-comment.sql`;
    const files = [{ path: filePath, content: readFixture('bad-claim-semicolon-in-comment.sql') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });

  it('a_drizzle_update_messageJobs_set_without_a_status_key_is_never_flagged', () => {
    const filePath = `${FIXTURES_DIR}/clean-drizzle.ts`;
    const files = [{ path: filePath, content: readFixture('clean-drizzle.ts') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations).toEqual([]);
  });

  it('a_drizzle_set_object_with_a_nested_object_before_the_status_key_is_rejected', () => {
    // P03 close, finding 3a: `{ payload: { a: 1 }, status: 'processing' }` -
    // a single-level `[^}]*` object-body scan ends at the inner `}` and
    // never reaches the real `status` key; brace-balanced scanning must not.
    const filePath = `${FIXTURES_DIR}/bad-drizzle-claim-nested-object.ts`;
    const files = [{ path: filePath, content: readFixture('bad-drizzle-claim-nested-object.ts') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });

  it('a_drizzle_builder_split_across_statements_is_rejected', () => {
    // P03 close, finding 3b: `const b = db.update(messageJobs); b.set({
    // status: ... })` - a same-expression-only chain match never sees a
    // `.set(` called on a variable bound to the update result in an earlier
    // statement.
    const filePath = `${FIXTURES_DIR}/bad-drizzle-claim-split-builder.ts`;
    const files = [{ path: filePath, content: readFixture('bad-drizzle-claim-split-builder.ts') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });

  it('a_conditional_transition_update_using_processing_only_as_a_where_predicate_is_never_flagged', () => {
    // P09 debugger fix, now wired: clean-where-predicate.sql/.ts existed on
    // disk with no asserting test (documented gap). Both the literal-WHERE
    // and parameterized-WHERE shapes must stay clean.
    const sqlPath = `${FIXTURES_DIR}/clean-where-predicate.sql`;
    const tsPath = `${FIXTURES_DIR}/clean-where-predicate.ts`;
    const files = [
      { path: sqlPath, content: readFixture('clean-where-predicate.sql') },
      { path: tsPath, content: readFixture('clean-where-predicate.ts') },
    ];

    expect(scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH)).toEqual([]);
  });

  it('a_for_update_skip_locked_row_lock_clause_ahead_of_a_clean_update_is_never_flagged', () => {
    // Debugger, P12 (2026-09-01): reproduces the exact false positive from
    // db/migrations/0027_reaper_and_reconcile_definer_functions.sql -
    // `FOR UPDATE OF j SKIP LOCKED` matched `\bUPDATE\b`, and a `--` comment
    // containing `j.status = 'processing'` was still fully scannable, so the
    // bounded gap landed on it though the real SET never writes 'processing'.
    const filePath = `${FIXTURES_DIR}/clean-for-update-skip-locked.sql`;
    const files = [{ path: filePath, content: readFixture('clean-for-update-skip-locked.sql') }];

    expect(scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH)).toEqual([]);
  });

  it('a_real_second_claim_behind_a_for_update_skip_locked_clause_is_still_rejected', () => {
    // P12: proves the FOR UPDATE row-lock exclusion did not open a hole - a
    // `FOR UPDATE SKIP LOCKED` clause AND a genuine claim UPDATE together.
    const name = 'bad-claim-for-update-skip-locked.sql';
    const filePath = `${FIXTURES_DIR}/${name}`;
    const files = [{ path: filePath, content: readFixture(name) }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });

  it('a_real_second_claim_interleaved_with_line_comments_on_every_side_is_still_rejected', () => {
    // P12: proves blanking whole `--` comment bodies did not open a hole - a
    // real claim surrounded by comments before SET, inside the assignment
    // list, and trailing on the same line must still be flagged.
    const filePath = `${FIXTURES_DIR}/bad-claim-comment-noise.sql`;
    const files = [{ path: filePath, content: readFixture('bad-claim-comment-noise.sql') }];

    const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });
});
