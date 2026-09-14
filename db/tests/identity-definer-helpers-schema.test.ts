import { afterAll, describe, expect, it } from 'vitest';
import { fetchFunctionAttributes } from './helpers/grants.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * P04a FIXA (C1 review fix, FIX 1) - db/migrations/0015_identity_definer_helpers.sql.
 * Sibling of grants-snapshot.test.ts's boot-gate function test (migration
 * 0005/0006), same conventions: definer-owned by the BYPASSRLS role, pinned
 * search_path, EXECUTE granted to exactly wp_app and NOT to PUBLIC.
 */
describe('identity_definer_helpers_schema', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('wp_client_id_for_user_is_definer_owned_by_the_bypassrls_role_with_a_pinned_search_path', async () => {
    const pool = await getMigratedPool();
    const functions = await fetchFunctionAttributes(pool);
    const fn = functions.find((f) => f.proname === 'wp_client_id_for_user');

    expect(fn, 'wp_client_id_for_user: function not found').toBeDefined();
    expect(fn?.prosecdef).toBe(true);
    expect(fn?.owner).toBe('wp_admin_app');

    const searchPathEntry = fn?.proconfig?.find((entry) => entry.startsWith('search_path='));
    expect(searchPathEntry).toBeDefined();
    expect(searchPathEntry).toContain('pg_catalog');
  });

  it('wp_client_id_for_user_execute_is_granted_to_wp_app_and_not_to_public', async () => {
    const pool = await getMigratedPool();

    const grantedRows = await pool.query<{ grantee: string }>(
      `SELECT DISTINCT grantee
         FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name = 'wp_client_id_for_user'
          AND privilege_type = 'EXECUTE'`,
    );
    const grantees = grantedRows.rows.map((row) => row.grantee);

    expect(grantees).toContain('wp_app');
    expect(grantees).not.toContain('PUBLIC');
  });
});
