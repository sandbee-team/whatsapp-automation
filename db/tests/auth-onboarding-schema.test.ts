import { afterAll, describe, expect, it } from 'vitest';
import {
  checkAllowListExists,
  checkCoverage,
  ISOLATION_NON_TENANT_TABLES,
  TENANT_TABLE_COVERAGE,
} from '../src/index.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import { fetchCatalogRows } from './helpers/isolation-fixtures.js';

/**
 * P04a (auth-signup-and-onboarding) Unit UA1 - db/migrations/0013_auth_and_onboarding.sql.
 */
describe('auth_and_onboarding_schema', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('new_auth_tables_are_on_the_non_tenant_allow_list_with_reasons', async () => {
    const newAuthAllowListTables = [
      'auth_sessions',
      'email_verification_tokens',
      'password_reset_tokens',
      'audit_logs',
    ];

    for (const tableName of newAuthAllowListTables) {
      const reason = ISOLATION_NON_TENANT_TABLES[tableName];
      expect(reason, `${tableName}: missing ISOLATION_NON_TENANT_TABLES entry`).toBeDefined();
      expect(
        (reason ?? '').trim().length,
        `${tableName}: ISOLATION_NON_TENANT_TABLES reason is empty/whitespace`,
      ).toBeGreaterThan(0);
    }

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

  it('users_token_epoch_is_not_null_default_zero', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ column_default: string | null; is_nullable: 'YES' | 'NO' }>(
      `SELECT column_default, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'token_epoch'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.is_nullable).toBe('NO');
    expect(result.rows[0]?.column_default).toContain('0');
  });

  it('audit_logs_is_partitioned_with_three_monthly_partitions_present', async () => {
    const pool = await getMigratedPool();

    const partitionedCheck = await pool.query<{ count: number }>(`
      SELECT count(*)::int AS count
        FROM pg_catalog.pg_partitioned_table pt
        JOIN pg_catalog.pg_class c ON c.oid = pt.partrelid
       WHERE c.relname = 'audit_logs'
    `);
    expect(partitionedCheck.rows[0]?.count).toBe(1);

    const children = await pool.query<{ table_name: string }>(`
      SELECT c.relname AS table_name
        FROM pg_catalog.pg_inherits i
        JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'audit_logs'::regclass
    `);
    // At least the three seeded at migration-apply time (current + 2 months
    // ahead) - could be more if this test runs across a month boundary from
    // when the migration first applied, never fewer.
    expect(children.rows.length).toBeGreaterThanOrEqual(3);
  });

  it('auth_sessions_refresh_token_hash_is_unique', async () => {
    const pool = await getMigratedPool();

    const result = await pool.query<{ indisunique: boolean }>(`
      SELECT DISTINCT ix.indisunique
        FROM pg_catalog.pg_index ix
        JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
        JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
       WHERE t.relname = 'auth_sessions'
         AND a.attname = 'refresh_token_hash'
         AND ix.indisunique
    `);
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect(result.rows[0]?.indisunique).toBe(true);
  });
});
