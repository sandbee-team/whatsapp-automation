import { afterAll, describe, expect, it } from 'vitest';
import {
  checkAllowListExists,
  checkCoverage,
  ISOLATION_NON_TENANT_TABLES,
  TENANT_TABLE_COVERAGE,
} from '../src/index.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import { fetchCatalogRows } from './helpers/isolation-fixtures.js';
import { fetchLiveGrantsForTables } from './helpers/grants.js';

/**
 * P04a (auth-signup-and-onboarding) Unit UA5b - db/migrations/0014_mfa_recovery_codes.sql.
 * Sibling of auth-onboarding-schema.test.ts (migration 0013), same conventions.
 *
 * P04b Unit UB1c adds the wp_app grant-set assertion below (migration 0016):
 * asserted post-apply against the live migrated dev DB, not written RED
 * against the pre-0016 snapshot first - `getMigratedPool()` always migrates
 * to the current on-disk HEAD before this suite runs, so there is no
 * pre-migration state left to assert against within this test file itself
 * (the live-DB before/after check for 0016 was done manually via psql, see
 * the P04b UB1c task report).
 */
describe('mfa_recovery_codes_schema', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('mfa_recovery_codes_is_on_the_non_tenant_allow_list_with_a_reason', async () => {
    const reason = ISOLATION_NON_TENANT_TABLES['mfa_recovery_codes'];
    expect(reason, 'mfa_recovery_codes: missing ISOLATION_NON_TENANT_TABLES entry').toBeDefined();
    expect(
      (reason ?? '').trim().length,
      'mfa_recovery_codes: ISOLATION_NON_TENANT_TABLES reason is empty/whitespace',
    ).toBeGreaterThan(0);

    // Isolation suite A still passes: the live catalog scan against the
    // updated registry produces zero coverage/allow-list findings.
    const pool = await getMigratedPool();
    const catalogRows = await fetchCatalogRows(pool);
    const registry = { coverage: TENANT_TABLE_COVERAGE, nonTenant: ISOLATION_NON_TENANT_TABLES };

    const coverageFindings = checkCoverage(catalogRows, registry);
    expect(coverageFindings, JSON.stringify(coverageFindings, null, 2)).toEqual([]);

    const liveTableNames = catalogRows.map((row) => row.tableName);
    const allowListFindings = checkAllowListExists(liveTableNames, ISOLATION_NON_TENANT_TABLES);
    expect(allowListFindings, JSON.stringify(allowListFindings, null, 2)).toEqual([]);
  });

  it('mfa_recovery_codes_table_exists_with_expected_columns', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ column_name: string; is_nullable: 'YES' | 'NO' }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'mfa_recovery_codes'`,
    );
    const byName = new Map(result.rows.map((row) => [row.column_name, row.is_nullable]));
    expect(byName.get('id')).toBe('NO');
    expect(byName.get('user_id')).toBe('NO');
    expect(byName.get('code_hash')).toBe('NO');
    expect(byName.get('used_at')).toBe('YES');
    expect(byName.get('created_at')).toBe('NO');
  });

  it('mfa_recovery_codes_code_hash_is_unique', async () => {
    const pool = await getMigratedPool();

    const result = await pool.query<{ indisunique: boolean }>(`
      SELECT DISTINCT ix.indisunique
        FROM pg_catalog.pg_index ix
        JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
        JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
       WHERE t.relname = 'mfa_recovery_codes'
         AND a.attname = 'code_hash'
         AND ix.indisunique
    `);
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect(result.rows[0]?.indisunique).toBe(true);
  });

  it('wp_app_holds_exactly_select_insert_update_delete_on_mfa_recovery_codes', async () => {
    const pool = await getMigratedPool();

    // Migration 0016 (P04b wp_app proof-work fix): wp_app must hold DELETE
    // alongside 0014's original SELECT/INSERT/UPDATE - `enrolConfirm`
    // (totp.service.ts) issues `deleteUnusedMfaRecoveryCodes` as the first
    // statement of its delete-then-insert transaction, so a missing DELETE
    // grant fails that transaction outright under wp_app + FORCE RLS.
    const grants = await fetchLiveGrantsForTables(pool, 'wp_app', ['mfa_recovery_codes']);
    const privileges = grants.map((row) => row.privilege_type).sort();

    expect(privileges).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });
});
