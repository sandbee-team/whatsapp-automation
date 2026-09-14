import { readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { describe, expect, it } from 'vitest';
import { scanTenantScope, TENANT_TABLES, TEST_FILE_PATTERN } from '../check-tenant-scope.js';
import { REPO_ROOT } from './registry.js';

/**
 * Fixture proof for check-tenant-scope.ts (P00 step 6, core invariant 4).
 * `scanTenantScope` is a pure function over already-read source text, so
 * every case here feeds it the same fixture content
 * (`__fixtures__/tenant-scope/queries.ts`) with different `tenantTables` /
 * `registry` arguments - never touching the real filesystem scan.
 */

const FIXTURE_PATH = 'scripts/guards/__fixtures__/tenant-scope/queries.ts';
const SQL_FIXTURE_PATH = 'scripts/guards/__fixtures__/tenant-scope/queries.sql';

function readFixture(): string {
  return readFileSync(path.join(REPO_ROOT, FIXTURE_PATH), 'utf8');
}

function readSqlFixture(): string {
  return readFileSync(path.join(REPO_ROOT, SQL_FIXTURE_PATH), 'utf8');
}

describe('check-tenant-scope (P00 step 6)', () => {
  it('a_tenant_table_query_without_client_id_is_rejected', () => {
    const content = readFixture();

    const violations = scanTenantScope([{ path: FIXTURE_PATH, content }], ['message_jobs'], {});

    expect(
      violations.some(
        (violation) => violation.file === FIXTURE_PATH && violation.symbol === 'listQueuedJobs',
      ),
    ).toBe(true);
  });

  it('the_same_query_with_a_client_id_predicate_is_clean', () => {
    const content = readFixture();

    const violations = scanTenantScope([{ path: FIXTURE_PATH, content }], ['message_jobs'], {});

    expect(violations.some((violation) => violation.symbol === 'listQueuedJobsForClient')).toBe(
      false,
    );
  });

  it('a_cross_tenant_query_needs_a_registry_entry_with_role_and_reason', () => {
    const content = readFixture();
    const key = `${FIXTURE_PATH}:platformWorklistRead`;
    const files = [{ path: FIXTURE_PATH, content }];

    // No registry entry at all -> violation.
    const noEntry = scanTenantScope(files, ['message_jobs'], {});
    expect(noEntry.some((violation) => violation.symbol === 'platformWorklistRead')).toBe(true);

    // Entry missing `reason` -> still a violation (an incomplete entry is
    // itself a violation, not a valid exemption).
    const incompleteEntry = scanTenantScope(files, ['message_jobs'], {
      [key]: { role: 'scheduler', reason: '', projectedColumns: ['id'] },
    });
    expect(incompleteEntry.some((violation) => violation.symbol === 'platformWorklistRead')).toBe(
      true,
    );

    // Full entry (role + reason + projectedColumns) -> clean.
    const fullEntry = scanTenantScope(files, ['message_jobs'], {
      [key]: {
        role: 'scheduler',
        reason: 'worklist scan needs cross-tenant next_attempt_at ordering',
        projectedColumns: ['id', 'next_attempt_at'],
      },
    });
    expect(fullEntry.some((violation) => violation.symbol === 'platformWorklistRead')).toBe(false);
  });

  // --- Raw .sql handling (P03 Unit C: db/queries/*.sql is scanned bare-text,
  // not quote-delimited like .ts source - see sqlStatementSpans' doc comment
  // in check-tenant-scope.ts) --------------------------------------------

  it('a_tenant_table_query_in_a_raw_sql_file_without_client_id_is_rejected', () => {
    const content = readSqlFixture();

    const violations = scanTenantScope([{ path: SQL_FIXTURE_PATH, content }], ['message_jobs'], {});

    expect(
      violations.some(
        (violation) => violation.file === SQL_FIXTURE_PATH && violation.symbol === 'listQueuedJobs',
      ),
    ).toBe(true);
  });

  it('the_same_raw_sql_query_with_a_client_id_predicate_is_clean', () => {
    const content = readSqlFixture();

    const violations = scanTenantScope([{ path: SQL_FIXTURE_PATH, content }], ['message_jobs'], {});

    expect(violations.some((violation) => violation.symbol === 'listQueuedJobsForClient')).toBe(
      false,
    );
  });

  it('a_cross_tenant_raw_sql_query_needs_a_registry_entry_with_role_and_reason', () => {
    const content = readSqlFixture();
    const key = `${SQL_FIXTURE_PATH}:platformWorklistRead`;
    const files = [{ path: SQL_FIXTURE_PATH, content }];

    const noEntry = scanTenantScope(files, ['message_jobs'], {});
    expect(noEntry.some((violation) => violation.symbol === 'platformWorklistRead')).toBe(true);

    const fullEntry = scanTenantScope(files, ['message_jobs'], {
      [key]: {
        role: 'scheduler',
        reason: 'worklist scan needs cross-tenant next_attempt_at ordering',
        projectedColumns: ['id', 'next_attempt_at'],
      },
    });
    expect(fullEntry.some((violation) => violation.symbol === 'platformWorklistRead')).toBe(false);
  });

  it('a_ddl_maintenance_sql_file_with_no_tenant_table_reference_flags_nothing', () => {
    // Mirrors db/queries/ensure-partitions.sql's shape: named statements that
    // call an owner-only maintenance function, never referencing a tenant
    // table by FROM/INTO/UPDATE/JOIN - correctly zero violations either way.
    const content = `-- name: ensureMonthlyPartition\nSELECT public.wp_ensure_month_partition($1::regclass, $2::date);\n`;

    const violations = scanTenantScope(
      [{ path: 'db/queries/ensure-partitions.sql', content }],
      ['message_jobs'],
      {},
    );

    expect(violations).toEqual([]);
  });

  it('an_empty_tenant_tables_list_flags_nothing', () => {
    const content = readFixture();

    const violations = scanTenantScope([{ path: FIXTURE_PATH, content }], [], {});

    expect(violations).toEqual([]);
  });

  // --- Edge-case pass (session C2) ----------------------------------------

  it('an_empty_file_list_flags_nothing', () => {
    expect(scanTenantScope([], ['message_jobs'], {})).toEqual([]);
  });

  it('a_thousand_repeated_violating_files_are_all_reported_and_stay_fast', () => {
    const content = readFixture();
    const files = Array.from({ length: 1000 }, (_, i) => ({
      path: `${FIXTURE_PATH}#${String(i)}`,
      content,
    }));

    const start = performance.now();
    const violations = scanTenantScope(files, ['message_jobs'], {});
    const elapsedMs = performance.now() - start;

    // Each file contributes exactly three violations: listQueuedJobs
    // (unscoped), platformWorklistRead (no registry entry), and
    // commentApostropheBeforeUnscopedUpdate (the comment-quote-misalignment
    // regression fixture's genuinely-unscoped sibling) - every other fixture
    // symbol (listQueuedJobsForClient, precedingSymbol,
    // commentApostropheBeforeScopedUpdate) is correctly scoped/clean.
    expect(violations.length).toBe(3000);
    expect(elapsedMs).toBeLessThan(3000);
  });

  // --- Test-path exemption convention (P03 Unit fix) ----------------------

  it('an_app_backend_integration_test_file_matches_the_established_test_path_convention', () => {
    // The exact file that tripped check-tenant-scope this session - it must
    // be exempted by the SAME convention that already keeps db/tests/*.test.ts
    // files green, not by a bespoke carve-out.
    expect(TEST_FILE_PATTERN.test('app/backend/src/modules/queue/claim.integration.test.ts')).toBe(
      true,
    );
  });

  it('db_tests_isolation_suite_files_match_the_same_convention', () => {
    expect(TEST_FILE_PATTERN.test('db/tests/isolation-suite-a.test.ts')).toBe(true);
    expect(TEST_FILE_PATTERN.test('db/tests/tenancy.test.ts')).toBe(true);
  });

  it('ordinary_application_source_files_do_not_match_the_test_path_convention', () => {
    // The exemption must stay exactly as narrow as "this is a test file" -
    // never broad enough to also exempt the runtime module it tests.
    expect(TEST_FILE_PATTERN.test('app/backend/src/modules/queue/claim.ts')).toBe(false);
    expect(TEST_FILE_PATTERN.test('db/src/isolation/tenant-tables.ts')).toBe(false);
    expect(TEST_FILE_PATTERN.test('packages/domain/src/queue/priority.ts')).toBe(false);
  });

  // --- Comment-quote misalignment regression (P09 drain.ts) ---------------
  //
  // literalSpans pairs `` ` ``/`'`/`"` naively. A JSDoc block comment
  // containing an English possessive apostrophe ("caller's") or a
  // markdown-style inline-code backtick, sitting directly above a real
  // multi-line template-literal SQL statement, could pair a quote inside
  // the comment with an unrelated quote several lines later INSIDE the real
  // statement - merging two unrelated spans, splitting a genuine predicate
  // away from its table reference, and misattributing the resulting
  // violation to the PRECEDING exported symbol instead of the one the
  // query actually belongs to. Fixed by stripping comments (preserving
  // indices/newlines) before the literal-span scan.

  it('a_client_id_scoped_query_preceded_by_a_comment_with_an_apostrophe_and_backticks_is_clean', () => {
    const content = readFixture();

    const violations = scanTenantScope([{ path: FIXTURE_PATH, content }], ['message_jobs'], {});

    expect(
      violations.some((violation) => violation.symbol === 'commentApostropheBeforeScopedUpdate'),
    ).toBe(false);
    // The false-positive this bug produced attributed the violation to the
    // PRECEDING exported symbol - pin that it never regresses onto it either.
    expect(violations.some((violation) => violation.symbol === 'precedingSymbol')).toBe(false);
  });

  it('the_same_comment_shape_with_a_genuinely_unscoped_query_is_still_flagged_and_correctly_attributed', () => {
    const content = readFixture();

    const violations = scanTenantScope([{ path: FIXTURE_PATH, content }], ['message_jobs'], {});

    expect(
      violations.some((violation) => violation.symbol === 'commentApostropheBeforeUnscopedUpdate'),
    ).toBe(true);
    // Must never be misattributed to the preceding symbol, and the correctly
    // scoped sibling above it must stay clean.
    expect(violations.some((violation) => violation.symbol === 'precedingSymbol')).toBe(false);
    expect(
      violations.some((violation) => violation.symbol === 'commentApostropheBeforeScopedUpdate'),
    ).toBe(false);
  });

  it('tenant_tables_must_be_filled_once_db_schema_exists', () => {
    // Tripwire (MAJOR 5): TENANT_TABLES starts empty because no schema
    // exists yet (db/schema/ has only a README today - see
    // check-tenant-scope.ts's module doc). The moment a real schema file
    // lands under db/schema/, this test must fail until TENANT_TABLES is
    // populated - it must never silently keep passing with an empty list.
    const schemaFiles = fg.sync(['db/schema/**/*.{ts,sql}'], {
      cwd: REPO_ROOT,
      ignore: ['db/schema/README.md'],
      onlyFiles: true,
    });

    if (schemaFiles.length === 0) {
      expect(TENANT_TABLES).toEqual([]);
      return;
    }

    expect(
      TENANT_TABLES.length,
      `db/schema/ now has ${String(schemaFiles.length)} file(s) but TENANT_TABLES is still empty - ` +
        'populate it (P02) so check-tenant-scope.ts actually scans real tenant tables.',
    ).toBeGreaterThan(0);
  });
});
