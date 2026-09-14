import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanSqlLint } from '../check-sql-lint.js';
import { REPO_ROOT } from './registry.js';

/**
 * Fixture proof for check-sql-lint.ts (MAJOR 4) - raw `db/**\/*.sql` text
 * scan for plain `SET ` (not `SET LOCAL`/`set_config(...,true)`) and
 * `OFFSET`, twin of the ESLint guard's SET_ENTRIES/OFFSET_ENTRIES
 * (`packages/config/eslint.config.js`) but over `.sql` files instead of TS
 * string/template literals. `scanSqlLint` is a pure function over
 * already-read source text - no filesystem access.
 */

const FIXTURES_DIR = 'scripts/guards/__fixtures__/sql';

function readFixture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, FIXTURES_DIR, name), 'utf8');
}

describe('check-sql-lint (MAJOR 4)', () => {
  it('a_plain_set_statement_in_raw_sql_is_rejected', () => {
    const filePath = 'db/migrations/0001_bad.sql';
    const violations = scanSqlLint([{ path: filePath, content: readFixture('bad-plain-set.sql') }]);

    expect(
      violations.some(
        (violation) => violation.file === filePath && violation.message.includes('SET'),
      ),
    ).toBe(true);
  });

  it('an_offset_clause_in_raw_sql_is_rejected', () => {
    const filePath = 'db/queries/bad.sql';
    const violations = scanSqlLint([{ path: filePath, content: readFixture('bad-offset.sql') }]);

    expect(
      violations.some(
        (violation) => violation.file === filePath && violation.message.includes('OFFSET'),
      ),
    ).toBe(true);
  });

  it('set_local_and_set_config_are_clean', () => {
    const filePath = 'db/migrations/0002_clean.sql';
    const violations = scanSqlLint([
      { path: filePath, content: readFixture('clean-set-local.sql') },
    ]);

    expect(violations).toEqual([]);
  });

  it('a_conditional_update_set_clause_shaped_like_the_claim_is_clean', () => {
    // P03: db/queries/claim-jobs.sql's own WITH-CTE + `FOR UPDATE OF ...
    // SKIP LOCKED` + conditional `UPDATE ... SET ...` shape must never be
    // flagged - this is the false positive the guard was fixed for.
    const filePath = 'db/queries/claim-jobs.sql';
    const violations = scanSqlLint([
      { path: filePath, content: readFixture('clean-claim-shape.sql') },
    ]);

    expect(violations).toEqual([]);
  });

  it('a_plain_set_statement_after_an_unrelated_update_is_still_rejected', () => {
    // P03 regression guard: proves the per-statement "kind" tracking resets
    // at every top-level `;` - a legitimate UPDATE ... SET earlier in the
    // file must not exempt a later, unrelated standalone SET statement.
    const filePath = 'db/migrations/0003_bad.sql';
    const violations = scanSqlLint([
      { path: filePath, content: readFixture('bad-plain-set-after-update.sql') },
    ]);

    expect(
      violations.some(
        (violation) => violation.file === filePath && violation.message.includes('SET'),
      ),
    ).toBe(true);
    // Exactly one violation - the UPDATE ... SET clause itself must not
    // also be (mis)flagged.
    expect(violations).toHaveLength(1);
  });

  it('a_security_definer_function_set_search_path_clause_is_clean', () => {
    // P03: db/migrations/0006's `SECURITY DEFINER SET search_path = ...`
    // function attribute (Postgres-scoped and reverted per call, not a
    // session leak) must stay clean, including the DO $$ ... $$ block that
    // follows it in the same file.
    const filePath = 'db/migrations/0006_definer_hardening_and_grant_narrowing.sql';
    const violations = scanSqlLint([
      { path: filePath, content: readFixture('clean-security-definer-set.sql') },
    ]);

    expect(violations).toEqual([]);
  });

  it('an_alter_table_set_storage_parameter_clause_is_clean', () => {
    // P03 close, note 12: ALTER TABLE ... SET (fillfactor=...) is a DDL
    // table storage attribute, not a banned session-scoped SET.
    const filePath = 'db/migrations/0010_claim_join_shells.sql';
    const violations = scanSqlLint([
      { path: filePath, content: readFixture('alter-table-set-storage.sql') },
    ]);

    expect(violations).toEqual([]);
  });

  it('an_alter_role_set_search_path_clause_is_rejected', () => {
    // P03 close, finding 1: a bare `ALTER` SET-exemption would also cover
    // `ALTER ROLE ... SET search_path = ...` / `ALTER DATABASE ... SET ...`
    // - a persistent, cross-session default, strictly worse than the plain
    // session SET this guard bans. Only `ALTER TABLE ... SET (...)` is exempt.
    const filePath = 'db/migrations/0011_bad.sql';
    const violations = scanSqlLint([
      { path: filePath, content: readFixture('bad-alter-role-set.sql') },
    ]);

    expect(
      violations.some(
        (violation) => violation.file === filePath && violation.message.includes('SET'),
      ),
    ).toBe(true);
  });

  it('an_empty_file_list_flags_nothing', () => {
    expect(scanSqlLint([])).toEqual([]);
  });

  it('an_offset_mention_inside_a_comment_or_string_is_clean', () => {
    // P17 close (gate attempt 2): migration 0048's index comment documented
    // "keyset list, no OFFSET" and tripped the raw-text scan. Opaque spans
    // (comments, string literals, dollar bodies) are masked before the
    // OFFSET scan, per the same doctrine the SET check already follows.
    const filePath = 'db/migrations/0048_notifications.sql';
    const violations = scanSqlLint([
      { path: filePath, content: readFixture('clean-offset-in-comment.sql') },
    ]);

    expect(violations).toEqual([]);
  });

  it('an_executable_offset_is_still_rejected_when_a_comment_also_mentions_it', () => {
    // Negative control for the masking: masking opaque spans must not eat
    // the real executable clause, and the reported line must be the
    // executable one (masking preserves offsets/line numbers).
    const filePath = 'db/queries/bad-mixed.sql';
    const fixture = readFixture('bad-offset-with-comment-mention.sql');
    const violations = scanSqlLint([{ path: filePath, content: fixture }]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(filePath);
    expect(violations[0]?.line).toBe(
      fixture.split('\n').findIndex((l) => l.includes('LIMIT 50')) + 1,
    );
  });

  it('alter_column_set_not_null_is_not_a_plain_set', () => {
    // P14 C5: db/migrations/0040's exact multi-clause ALTER TABLE ... ALTER
    // COLUMN ... SET NOT NULL, ... shape (an applied, content-hashed
    // migration) is a column-attribute DDL form, not a session-scoped SET -
    // must stay clean.
    const filePath = 'db/migrations/0040_guard_pipeline_grant_fixes_and_thresholds.sql';
    const violations = scanSqlLint([
      { path: filePath, content: readFixture('alter-column-set-not-null.sql') },
    ]);

    expect(violations).toEqual([]);
  });

  it('set_default_and_set_data_type_are_not_plain_sets', () => {
    // P14 C5: ALTER COLUMN ... SET DEFAULT / SET DATA TYPE / SET STATISTICS
    // are the other column-attribute ALTER COLUMN forms - none of these
    // token sequences can be a session-variable assignment.
    const filePath = 'db/migrations/0041_clean.sql';
    const violations = scanSqlLint([
      { path: filePath, content: readFixture('alter-column-set-default-and-type.sql') },
    ]);

    expect(violations).toEqual([]);
  });

  it('a_standalone_set_search_path_outside_create_function_is_rejected', () => {
    // P14 C5 negative: only the CREATE FUNCTION ... SECURITY DEFINER SET
    // search_path attribute clause is exempt - the same SET outside that
    // context is a real session-scoped leak.
    const filePath = 'db/migrations/0042_bad.sql';
    const violations = scanSqlLint([
      { path: filePath, content: readFixture('bad-set-search-path-standalone.sql') },
    ]);

    expect(
      violations.some(
        (violation) => violation.file === filePath && violation.message.includes('SET'),
      ),
    ).toBe(true);
  });

  it('a_plain_set_of_a_custom_session_variable_without_local_is_rejected', () => {
    // P14 C5 negative: SET app.client_id = '...' (no LOCAL) is exactly the
    // cross-tenant leak class this guard bans.
    const filePath = 'db/migrations/0043_bad.sql';
    const violations = scanSqlLint([
      { path: filePath, content: readFixture('bad-set-app-client-id.sql') },
    ]);

    expect(
      violations.some(
        (violation) => violation.file === filePath && violation.message.includes('SET'),
      ),
    ).toBe(true);
  });
});
