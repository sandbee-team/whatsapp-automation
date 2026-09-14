import { afterAll, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import { fetchUnkeyedUniqueIndexes } from './helpers/partition-fixtures.js';

/**
 * P18 (wallet-ledger-and-pricing) Unit U1 - schema tests for migration 0051
 * (`wallet_guards_and_rollups`): `wallet_charge_guards`, `wallet_daily_summary`,
 * `wallet_reconcile_findings`. Pure catalog/information_schema probes, no
 * business-logic writes - the guard-first debit path itself is a later P18
 * unit.
 */
describe('wallet_guards_schema', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('no_unique_index_on_a_partitioned_table_without_the_partition_key', async () => {
    const pool = await getMigratedPool();
    const violations = await fetchUnkeyedUniqueIndexes(pool);
    const guardViolations = violations.filter(
      (row) =>
        row.table_name === 'wallet_charge_guards' ||
        row.table_name.startsWith('wallet_charge_guards_'),
    );
    expect(guardViolations, JSON.stringify(guardViolations, null, 2)).toEqual([]);

    // Table + at least 4 children (previous month + current + next 2) actually exist.
    const childCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_catalog.pg_inherits i
         JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'wallet_charge_guards'::regclass`,
    );
    expect(Number(childCount.rows[0]?.count ?? '0')).toBeGreaterThanOrEqual(4);
  });

  it('wallet_daily_summary_has_no_nullable_column_in_its_primary_key', async () => {
    const pool = await getMigratedPool();

    const pkColumns = await pool.query<{ column_name: string; is_nullable: 'YES' | 'NO' }>(
      `SELECT kcu.column_name, col.is_nullable
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
         JOIN information_schema.columns col
           ON col.table_schema = tc.table_schema AND col.table_name = tc.table_name AND col.column_name = kcu.column_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'wallet_daily_summary'
          AND tc.constraint_type = 'PRIMARY KEY'`,
    );
    expect(pkColumns.rows.length).toBeGreaterThan(0);
    for (const row of pkColumns.rows) {
      expect(row.is_nullable, `${row.column_name} must be NOT NULL in the PK`).toBe('NO');
    }
    expect(pkColumns.rows.map((row) => row.column_name)).toContain('instance_id');
  });

  it('no_money_column_is_a_floating_point_type', async () => {
    const pool = await getMigratedPool();
    const tables = [
      'wallet_charge_guards',
      'wallet_daily_summary',
      'wallet_reconcile_findings',
      'wallet_accounts',
      'wallet_ledger',
    ];

    const minorColumns = await pool.query<{
      table_name: string;
      column_name: string;
      udt_name: string;
    }>(
      `SELECT table_name, column_name, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
          AND column_name LIKE '%\\_minor' ESCAPE '\\'`,
      [tables],
    );
    expect(minorColumns.rows.length).toBeGreaterThan(0);

    const notInt8 = minorColumns.rows.filter((row) => row.udt_name !== 'int8');
    expect(notInt8, JSON.stringify(notInt8, null, 2)).toEqual([]);

    const floatTyped = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
          AND udt_name IN ('float4', 'float8', 'numeric')`,
      [tables],
    );
    expect(floatTyped.rows, JSON.stringify(floatTyped.rows, null, 2)).toEqual([]);
  });

  it('wallet_charge_guards_created_at_has_no_default', async () => {
    const pool = await getMigratedPool();

    const columnCheck = await pool.query<{ column_default: string | null }>(
      `SELECT column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'wallet_charge_guards' AND column_name = 'created_at'`,
    );
    expect(columnCheck.rowCount).toBe(1);
    expect(columnCheck.rows[0]?.column_default).toBeNull();
  });

  it('wp_app_has_no_delete_grant_on_any_new_wallet_table', async () => {
    const pool = await getMigratedPool();
    const tables = ['wallet_charge_guards', 'wallet_daily_summary', 'wallet_reconcile_findings'];

    const deleteGrants = await pool.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND grantee = 'wp_app'
          AND table_name = ANY($1)
          AND privilege_type = 'DELETE'`,
      [tables],
    );
    expect(deleteGrants.rows, JSON.stringify(deleteGrants.rows, null, 2)).toEqual([]);

    const guardsColumnUpdate = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.column_privileges
        WHERE table_schema = 'public'
          AND grantee = 'wp_app'
          AND table_name = 'wallet_charge_guards'
          AND privilege_type = 'UPDATE'`,
    );
    expect(guardsColumnUpdate.rows.map((row) => row.column_name)).toEqual(['ledger_seq']);

    const guardsTableUpdate = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND grantee = 'wp_app'
          AND table_name = 'wallet_charge_guards'
          AND privilege_type = 'UPDATE'`,
    );
    // A table-level (all-columns) UPDATE grant would defeat the column-scoped
    // intent above - only the column-privileges row should exist.
    expect(guardsTableUpdate.rows, JSON.stringify(guardsTableUpdate.rows, null, 2)).toEqual([]);
  });
});
