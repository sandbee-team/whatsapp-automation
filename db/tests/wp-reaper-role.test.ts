import { afterAll, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * db/tests/wp-reaper-role.test.ts (P12 U2a) - split out of
 * `reaper-definer.test.ts` at the max-lines cap. Proves the `wp_reaper`
 * role's own shape in isolation from the two SECURITY DEFINER functions'
 * EXECUTE/ownership proofs (which stay in `reaper-definer.test.ts`): it
 * cannot log in, it holds no grant beyond the exact message_jobs/
 * send_attempts columns `wp_reap_expired_leases` needs, and no artifact from
 * the founder's live pre-migration design-spike (a probe role + probe
 * definer function, both created and dropped before this migration was
 * finalized - see `db/migrations/0027_reaper_and_reconcile_definer_
 * functions.sql`'s header for the exact commands run) leaked into this
 * database.
 */
describe('wp_reaper_role', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('no_probe_artifacts_remain_from_the_role_design_spike', async () => {
    const pool = await getMigratedPool();

    const roles = await pool.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname LIKE 'wp\\_probe%' ESCAPE '\\'`,
    );
    expect(roles.rows).toEqual([]);

    const functions = await pool.query<{ proname: string }>(
      `SELECT proname FROM pg_proc WHERE proname LIKE '%probe%'`,
    );
    expect(functions.rows).toEqual([]);

    const grants = await pool.query<{ grantee: string }>(
      `SELECT grantee FROM information_schema.role_table_grants WHERE grantee LIKE 'wp\\_probe%' ESCAPE '\\'`,
    );
    expect(grants.rows).toEqual([]);
  });

  it('wp_reaper_cannot_log_in', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ rolcanlogin: boolean; rolbypassrls: boolean }>(
      `SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'wp_reaper'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ rolcanlogin: false, rolbypassrls: true });
  });

  it('wp_reaper_has_no_grant_beyond_message_jobs_and_send_attempts', async () => {
    // Founder instruction 3: wp_reaper must hold no grant on any table
    // beyond the narrow message_jobs/send_attempts surface its one function
    // needs - explicitly checked against three tables from three different
    // sensitive classes (wallet/money, session credentials, auth).
    const pool = await getMigratedPool();

    // wp_reaper's grants are COLUMN-scoped (GRANT SELECT (col, ...) / GRANT
    // UPDATE (col, ...)), so they only ever appear in
    // information_schema.role_column_grants, never role_table_grants (which
    // is table-level-only - see grants.ts's fetchLiveColumnGrantsForTables
    // doc comment for the same distinction). Verified live: an ordinary
    // table-level GRANT expands to one role_column_grants row PER COLUMN,
    // but a column-narrowed GRANT never produces a role_table_grants row at
    // all - querying only the table-level view here would vacuously pass.
    const columnGrants = await pool.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_column_grants
        WHERE grantee = 'wp_reaper' AND table_schema = 'public'
        ORDER BY table_name, privilege_type`,
    );
    const tableNames = [...new Set(columnGrants.rows.map((row) => row.table_name))].sort();
    expect(tableNames).toEqual(['message_jobs', 'send_attempts']);

    // Also confirm no TABLE-level grant was accidentally introduced (the
    // migration must only ever use column-scoped GRANT statements for
    // wp_reaper).
    const tableGrants = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.role_table_grants
        WHERE grantee = 'wp_reaper' AND table_schema = 'public'`,
    );
    expect(tableGrants.rows[0]?.count).toBe('0');

    for (const forbiddenTable of [
      'wallet_accounts',
      'whatsapp_session_credentials',
      'auth_sessions',
    ]) {
      const forbiddenColumns = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.role_column_grants
          WHERE grantee = 'wp_reaper' AND table_schema = 'public' AND table_name = $1`,
        [forbiddenTable],
      );
      expect(forbiddenColumns.rows[0]?.count, forbiddenTable).toBe('0');
    }

    // wp_reaper must never be granted to any other role (it is not a
    // membership group - it exists purely to be a function owner).
    const memberships = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid
        WHERE r.rolname = 'wp_reaper'`,
    );
    expect(memberships.rows[0]?.count).toBe('0');

    // send_attempts must be SELECT-only for wp_reaper (it never writes there).
    const sendAttemptsPrivileges = [
      ...new Set(
        columnGrants.rows
          .filter((row) => row.table_name === 'send_attempts')
          .map((row) => row.privilege_type),
      ),
    ];
    expect(sendAttemptsPrivileges).toEqual(['SELECT']);
  });
});
