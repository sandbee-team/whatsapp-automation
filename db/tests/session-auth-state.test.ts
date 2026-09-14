import { afterAll, describe, expect, it } from 'vitest';
import { DURABLE_KEY_TYPES } from '@wp/domain';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import { fetchLiveGrantsForTables, fetchLiveColumnGrantsForTables } from './helpers/grants.js';

/**
 * P07 (session-auth-store) Unit U2 - db/migrations/0020_session_auth_state.sql.
 * The two durable session tables: `whatsapp_session_credentials` (one row per
 * instance, the full serialized Baileys creds) and `whatsapp_session_keys`
 * (one row per (instance, key_type, key_id) durable Signal key - only the
 * three DURABLE_KEY_TYPES from `@wp/domain`, the rest live in Redis).
 *
 * Both tables are RLS-FORCE'd tenant tables (client_id NOT NULL). Grants are
 * deliberately narrow: wp_app only - wp_scheduler gets nothing (it never
 * touches session ciphertext) and wp_admin_app gets nothing (staff must never
 * read session ciphertext, unlike whatsapp_instances which grants SELECT).
 */
describe('session_auth_state_schema', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('whatsapp_session_credentials_table_exists_with_expected_columns', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ column_name: string; is_nullable: 'YES' | 'NO' }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'whatsapp_session_credentials'`,
    );
    const byName = new Map(result.rows.map((row) => [row.column_name, row.is_nullable]));
    expect(byName.get('instance_id')).toBe('NO');
    expect(byName.get('client_id')).toBe('NO');
    expect(byName.get('ciphertext')).toBe('NO');
    expect(byName.get('iv')).toBe('NO');
    expect(byName.get('auth_tag')).toBe('NO');
    expect(byName.get('dek_wrapped')).toBe('NO');
    expect(byName.get('dek_iv')).toBe('NO');
    expect(byName.get('dek_tag')).toBe('NO');
    expect(byName.get('kek_id')).toBe('NO');
    expect(byName.get('enc_version')).toBe('NO');
    expect(byName.get('session_epoch')).toBe('NO');
    expect(byName.get('cred_version')).toBe('NO');
    expect(byName.get('owner_fence')).toBe('NO');
    expect(byName.get('updated_at')).toBe('NO');
    expect(byName.get('rotated_at')).toBe('YES');
  });

  it('whatsapp_session_keys_table_exists_with_expected_columns', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ column_name: string; is_nullable: 'YES' | 'NO' }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'whatsapp_session_keys'`,
    );
    const byName = new Map(result.rows.map((row) => [row.column_name, row.is_nullable]));
    expect(byName.get('instance_id')).toBe('NO');
    expect(byName.get('client_id')).toBe('NO');
    expect(byName.get('key_type')).toBe('NO');
    expect(byName.get('key_id')).toBe('NO');
    expect(byName.get('ciphertext')).toBe('NO');
    expect(byName.get('iv')).toBe('NO');
    expect(byName.get('auth_tag')).toBe('NO');
    expect(byName.get('dek_wrapped')).toBe('NO');
    expect(byName.get('dek_iv')).toBe('NO');
    expect(byName.get('dek_tag')).toBe('NO');
    expect(byName.get('kek_id')).toBe('NO');
    expect(byName.get('enc_version')).toBe('NO');
    expect(byName.get('owner_fence')).toBe('NO');
    expect(byName.get('updated_at')).toBe('NO');
  });

  it('session_key_type_check_matches_domain_durable_types', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(con.oid) AS definition
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'whatsapp_session_keys'
          AND con.contype = 'c'
          AND pg_get_constraintdef(con.oid) LIKE '%key_type%'`,
    );
    expect(result.rows).toHaveLength(1);
    const definition = result.rows[0]?.definition ?? '';

    const matches = [...definition.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(new Set(matches)).toEqual(new Set(DURABLE_KEY_TYPES));
  });

  it('both_tables_have_rowsecurity_and_forcerowsecurity_true', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_catalog.pg_class
        WHERE relname IN ('whatsapp_session_credentials', 'whatsapp_session_keys')`,
    );
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname}: rowsecurity`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname}: forcerowsecurity`).toBe(true);
    }
  });

  it('primary_key_shapes_are_as_specified', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ relname: string; attname: string }>(
      `SELECT t.relname, a.attname
         FROM pg_catalog.pg_index ix
         JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
         JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid
        WHERE ix.indisprimary
          AND t.relname IN ('whatsapp_session_credentials', 'whatsapp_session_keys')
          AND a.attnum = ANY(ix.indkey)
        ORDER BY t.relname, array_position(ix.indkey, a.attnum)`,
    );
    const byTable = new Map<string, string[]>();
    for (const row of result.rows) {
      byTable.set(row.relname, [...(byTable.get(row.relname) ?? []), row.attname]);
    }
    expect(byTable.get('whatsapp_session_credentials')).toEqual(['instance_id']);
    expect(byTable.get('whatsapp_session_keys')).toEqual(['instance_id', 'key_type', 'key_id']);
  });

  it('fillfactor_reloptions_are_present_on_both_tables', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT relname, reloptions
         FROM pg_catalog.pg_class
        WHERE relname IN ('whatsapp_session_credentials', 'whatsapp_session_keys')`,
    );
    const byName = new Map(result.rows.map((row) => [row.relname, row.reloptions ?? []]));

    const credentialsOpts = byName.get('whatsapp_session_credentials') ?? [];
    expect(credentialsOpts.some((opt) => opt.startsWith('fillfactor=80'))).toBe(true);

    const keysOpts = byName.get('whatsapp_session_keys') ?? [];
    expect(keysOpts.some((opt) => opt.startsWith('fillfactor=70'))).toBe(true);
    expect(keysOpts.some((opt) => opt.startsWith('autovacuum_vacuum_scale_factor=0.02'))).toBe(
      true,
    );
    expect(keysOpts.some((opt) => opt.startsWith('autovacuum_vacuum_cost_limit=2000'))).toBe(true);
  });

  it('wp_scheduler_and_wp_admin_app_have_zero_privileges_on_both_tables', async () => {
    const pool = await getMigratedPool();
    const tables = ['whatsapp_session_credentials', 'whatsapp_session_keys'];

    for (const grantee of ['wp_scheduler', 'wp_admin_app']) {
      const tableGrants = await fetchLiveGrantsForTables(pool, grantee, tables);
      const columnGrants = await fetchLiveColumnGrantsForTables(pool, grantee, tables);
      expect(tableGrants, `${grantee}: table grants`).toEqual([]);
      expect(columnGrants, `${grantee}: column grants`).toEqual([]);
    }
  });

  it('wp_app_has_exactly_select_insert_update_delete_on_both_tables', async () => {
    const pool = await getMigratedPool();
    const tables = ['whatsapp_session_credentials', 'whatsapp_session_keys'];
    const grants = await fetchLiveGrantsForTables(pool, 'wp_app', tables);

    for (const table of tables) {
      const privileges = grants
        .filter((row) => row.table_name === table)
        .map((row) => row.privilege_type)
        .sort();
      expect(privileges, table).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    }
  });
});
