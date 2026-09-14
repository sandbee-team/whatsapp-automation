import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import { fetchLiveGrantsForTables } from './helpers/grants.js';

/**
 * Go-live session, Unit U1 - schema tests for migration 0076 (`api_keys`).
 * Same fixture-per-file idiom as `leads-schema.test.ts`: seeds its own
 * client/user rows (no shared isolation fixture), tracks inserted ids, and
 * cleans up in `afterAll` (reverse FK order: api_keys -> clients/users).
 */

interface SeededParent {
  clientId: string;
  userId: string;
}

async function seedParent(
  pool: Awaited<ReturnType<typeof getMigratedPool>>,
): Promise<SeededParent> {
  const suffix = randomBytes(6).toString('hex');
  const clientId = randomUUID();
  const userId = randomUUID();
  await pool.query('INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [
    userId,
    `Api Keys Schema Probe ${suffix}`,
    `api-keys-schema-${suffix}@example.com`,
  ]);
  await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
    clientId,
    `Api Keys Schema Probe ${suffix}`,
    `api-keys-schema-${suffix}`,
  ]);
  return { clientId, userId };
}

function validPrefix(): string {
  return `wp_live_${randomBytes(6).toString('hex')}`;
}

describe('api_keys_schema', () => {
  const clientIds: string[] = [];
  const userIds: string[] = [];

  afterAll(async () => {
    const pool = await getMigratedPool();
    if (clientIds.length > 0) {
      await pool.query('DELETE FROM api_keys WHERE client_id = ANY($1::uuid[])', [clientIds]);
      await pool.query('DELETE FROM clients WHERE id = ANY($1::uuid[])', [clientIds]);
    }
    if (userIds.length > 0) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    }
    await closeMigratedPool();
  });

  it('api_keys_has_row_level_security_enabled_and_forced', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'api_keys'`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.relrowsecurity).toBe(true);
    expect(result.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it('api_keys_client_id_is_not_nullable', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ is_nullable: 'YES' | 'NO' }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'api_keys' AND column_name = 'client_id'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.is_nullable).toBe('NO');
  });

  it('api_keys_key_prefix_has_a_unique_index', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'api_keys' AND indexname = 'api_keys_key_prefix_uq'`,
    );
    expect(result.rows).toHaveLength(1);
  });

  it('api_keys_rejects_a_bad_key_prefix_and_a_bad_last4_at_the_storage_layer', async () => {
    const pool = await getMigratedPool();
    const parent = await seedParent(pool);
    clientIds.push(parent.clientId);
    userIds.push(parent.userId);

    const insertSql = `INSERT INTO api_keys (client_id, name, key_prefix, secret_hash, last4, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;

    await expect(
      pool.query(insertSql, [
        parent.clientId,
        'Bad Prefix Key',
        'not-a-valid-prefix',
        Buffer.from('0'.repeat(64), 'hex'),
        'ab12',
        parent.userId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      pool.query(insertSql, [
        parent.clientId,
        'Bad Last4 Key',
        validPrefix(),
        Buffer.from('0'.repeat(64), 'hex'),
        'ZZZZ',
        parent.userId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });

    const valid = await pool.query<{ id: string }>(insertSql, [
      parent.clientId,
      'Valid Key',
      validPrefix(),
      Buffer.from('0'.repeat(64), 'hex'),
      'ab12',
      parent.userId,
    ]);
    expect(valid.rows[0]?.id).toBeDefined();
  });

  it('wp_app_has_no_delete_privilege_on_api_keys', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'wp_app' AND table_schema = 'public' AND table_name = 'api_keys'`,
    );
    const privileges = result.rows.map((row) => row.privilege_type);
    expect(privileges).not.toContain('DELETE');
  });

  it('wp_app_grants_are_exactly_select_insert_table_level_plus_column_scoped_update', async () => {
    const pool = await getMigratedPool();
    const tableGrants = await fetchLiveGrantsForTables(pool, 'wp_app', ['api_keys']);
    const tableLevelPrivileges = [...new Set(tableGrants.map((row) => row.privilege_type))].sort();
    expect(tableLevelPrivileges).toEqual(['INSERT', 'SELECT']);

    const columnUpdateResult = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'wp_app' AND table_schema = 'public' AND table_name = 'api_keys'
          AND privilege_type = 'UPDATE'
        ORDER BY column_name`,
    );
    expect(columnUpdateResult.rows.map((row) => row.column_name)).toEqual([
      'last_used_at',
      'revoked_at',
    ]);
  });

  it('wp_admin_app_has_select_only_on_api_keys', async () => {
    const pool = await getMigratedPool();
    const tableGrants = await fetchLiveGrantsForTables(pool, 'wp_admin_app', ['api_keys']);
    expect([...new Set(tableGrants.map((row) => row.privilege_type))]).toEqual(['SELECT']);
  });
});
