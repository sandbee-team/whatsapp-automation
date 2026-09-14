import { afterAll, describe, expect, it } from 'vitest';
import { ISOLATION_NON_TENANT_TABLES, TENANT_TABLE_COVERAGE } from '../src/index.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * P28 (admin-internal-api-and-panel) Unit U1 - sibling of
 * `isolation-suite-a.test.ts` (that file sits near the 300-line cap), same
 * helpers/imports, one new case: the P28 tenant/non-tenant table
 * registrations.
 */
describe('isolation_suite_a_p28', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('every_new_admin_table_is_covered_or_reasoned', async () => {
    expect(TENANT_TABLE_COVERAGE.impersonation_grants).toBe('client_id');

    for (const tableName of ['staff_users', 'staff_sessions', 'staff_audit_log']) {
      const reason = ISOLATION_NON_TENANT_TABLES[tableName];
      expect(
        reason,
        `${tableName}: expected a non-empty ISOLATION_NON_TENANT_TABLES reason`,
      ).toBeTruthy();
    }

    const pool = await getMigratedPool();
    const result = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'impersonation_grants'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.relrowsecurity).toBe(true);
    expect(result.rows[0]?.relforcerowsecurity).toBe(true);

    const columnResult = await pool.query<{ is_nullable: 'YES' | 'NO' }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'impersonation_grants' AND column_name = 'client_id'`,
    );
    expect(columnResult.rows).toHaveLength(1);
    expect(columnResult.rows[0]?.is_nullable).toBe('NO');
  });
});
