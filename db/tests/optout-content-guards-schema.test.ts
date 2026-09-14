import { afterAll, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * P14 (safe-mode-guards) Unit U1 - schema tests for migration
 * 0036_optout_and_content_guards.sql. Asserts PKs, the opt_outs partial
 * unique index, RLS ENABLE+FORCE on all nine tables, and the no-DELETE
 * grant on opt_outs for every app role. Pure catalog/information_schema
 * scans - no probe rows to clean up.
 */
describe('optout_content_guards_schema', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  const NEW_TABLES = [
    'opt_outs',
    'optout_confirmations',
    'tenant_optout_keywords',
    'tenant_blocked_words',
    'content_fingerprints',
    'content_fingerprint_recipients',
    'recipient_send_buckets',
    'instance_recipient_contacts',
  ];

  // opt_outs' PK is a dedicated `id` surrogate (canonical DDL, per the phase
  // task's verbatim shape) - client_id is its second column, not its first;
  // every other new guard table leads with client_id as column 1.
  const CLIENT_ID_ORDINAL: Readonly<Record<string, number>> = { opt_outs: 2 };

  it('every_new_guard_table_leads_with_client_id_and_forces_rls', async () => {
    const pool = await getMigratedPool();

    for (const tableName of NEW_TABLES) {
      const columnResult = await pool.query<{ is_nullable: 'YES' | 'NO' }>(
        `SELECT is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'client_id'`,
        [tableName],
      );
      expect(columnResult.rows, `${tableName}: client_id column exists`).toHaveLength(1);
      expect(columnResult.rows[0]?.is_nullable, `${tableName}: client_id NOT NULL`).toBe('NO');

      const ordinalResult = await pool.query<{ ordinal_position: number }>(
        `SELECT ordinal_position
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'client_id'`,
        [tableName],
      );
      expect(
        ordinalResult.rows[0]?.ordinal_position,
        `${tableName}: client_id ordinal position`,
      ).toBe(CLIENT_ID_ORDINAL[tableName] ?? 1);

      const rlsResult = await pool.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        policy_count: number;
      }>(
        `SELECT c.relrowsecurity, c.relforcerowsecurity,
                (SELECT count(*)::int FROM pg_catalog.pg_policies pol
                  WHERE pol.schemaname = 'public' AND pol.tablename = c.relname
                    AND pol.policyname = 'tenant_isolation') AS policy_count
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1`,
        [tableName],
      );
      expect(rlsResult.rows, `${tableName}: exists in pg_class`).toHaveLength(1);
      const row = rlsResult.rows[0]!;
      expect(row.relrowsecurity, `${tableName}: relrowsecurity`).toBe(true);
      expect(row.relforcerowsecurity, `${tableName}: relforcerowsecurity`).toBe(true);
      expect(row.policy_count, `${tableName}: tenant_isolation policy`).toBe(1);
    }
  });

  it('opt_outs_lookup_is_a_partial_unique_index_on_client_id_scope_key_phone_hash', async () => {
    const pool = await getMigratedPool();

    const result = await pool.query<{
      indisunique: boolean;
      indpred: string | null;
      columns: string[];
    }>(
      `SELECT ix.indisunique, pg_get_expr(ix.indpred, ix.indrelid) AS indpred,
              array_agg(a.attname::text ORDER BY k.ord)::text[] AS columns
         FROM pg_catalog.pg_index ix
         JOIN pg_catalog.pg_class ic ON ic.oid = ix.indexrelid
         JOIN unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
        WHERE ic.relname = 'opt_outs_lookup'
        GROUP BY ix.indisunique, ix.indpred, ix.indrelid`,
    );

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.indisunique).toBe(true);
    expect(row.columns).toEqual(['client_id', 'scope_key', 'phone_hash']);
    expect(row.indpred).toContain('restored_at IS NULL');
  });

  it('opt_outs_primary_key_and_optout_confirmations_composite_primary_key_are_correct', async () => {
    const pool = await getMigratedPool();

    async function pkColumns(tableName: string): Promise<string[]> {
      const result = await pool.query<{ column_name: string }>(
        `SELECT a.attname AS column_name
           FROM pg_catalog.pg_index ix
           JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid
           JOIN unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
           JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
          WHERE c.relname = $1 AND ix.indisprimary
          ORDER BY k.ord`,
        [tableName],
      );
      return result.rows.map((row) => row.column_name);
    }

    expect(await pkColumns('opt_outs')).toEqual(['id']);
    expect(await pkColumns('optout_confirmations')).toEqual([
      'client_id',
      'scope_key',
      'phone_hash',
    ]);
    expect(await pkColumns('content_fingerprints')).toEqual([
      'client_id',
      'local_date',
      'fingerprint',
    ]);
    expect(await pkColumns('content_fingerprint_recipients')).toEqual([
      'client_id',
      'local_date',
      'fingerprint',
      'recipient_hash',
    ]);
    expect(await pkColumns('recipient_send_buckets')).toEqual([
      'client_id',
      'phone_hash',
      'hour_bucket',
    ]);
    expect(await pkColumns('tenant_optout_keywords')).toEqual(['client_id', 'keyword']);
    expect(await pkColumns('tenant_blocked_words')).toEqual(['client_id', 'word']);
    expect(await pkColumns('instance_recipient_contacts')).toEqual([
      'client_id',
      'instance_id',
      'recipient_hash',
    ]);
  });

  it('content_fingerprints_has_no_instance_id_column', async () => {
    // Blueprint amendment regression guard: the safe-mode design's original
    // instance-level PK is superseded by the client-level PK - this table
    // must never grow an instance_id column.
    const pool = await getMigratedPool();
    const result = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'content_fingerprints'
          AND column_name = 'instance_id'`,
    );
    expect(result.rows).toEqual([]);
  });

  it('opt_outs_has_no_delete_grant_for_any_app_role', async () => {
    const pool = await getMigratedPool();

    const result = await pool.query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = 'opt_outs'
          AND grantee IN ('wp_app', 'wp_admin_app', 'wp_scheduler')`,
    );

    const deleteGrants = result.rows.filter((row) => row.privilege_type === 'DELETE');
    expect(deleteGrants).toEqual([]);

    // Non-vacuous: wp_app must still hold its read/write grants.
    const wpAppPrivileges = result.rows
      .filter((row) => row.grantee === 'wp_app')
      .map((row) => row.privilege_type)
      .sort();
    expect(wpAppPrivileges).toEqual(['INSERT', 'SELECT', 'UPDATE']);

    // wp_scheduler gets NO grant on opt_outs - the guard pipeline reads
    // these tables under wp_app in the claim transaction (task instruction).
    const schedulerGrants = result.rows.filter((row) => row.grantee === 'wp_scheduler');
    expect(schedulerGrants).toEqual([]);
  });

  it('recipient_frequency_table_does_not_exist', async () => {
    // The safe-mode design's daily-count table is superseded by
    // recipient_send_buckets's rolling-hour buckets - it must never be
    // created.
    const pool = await getMigratedPool();
    const result = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_catalog.pg_tables
          WHERE schemaname = 'public' AND tablename = 'recipient_frequency'
       ) AS exists`,
    );
    expect(result.rows[0]?.exists).toBe(false);
  });
});
