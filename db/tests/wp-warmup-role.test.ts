import { afterAll, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * db/tests/wp-warmup-role.test.ts (P13a re-review, finding 2) - mirrors
 * `wp-reaper-role.test.ts` exactly for the `wp_warmup` role (migration 0034):
 * it cannot log in, it is deliberately BYPASSRLS (same "the one writing
 * definer function it owns needs it, and cannot do its one job without it"
 * reasoning wp_reaper's own header/grants-snapshot.test.ts comment gives),
 * and it holds no grant beyond the exact instance_pacing_state/audit_logs/
 * pacing_events surface `wp_warmup_apply_tier_change` needs.
 */
describe('wp_warmup_role', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('wp_warmup_cannot_log_in', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ rolcanlogin: boolean; rolbypassrls: boolean }>(
      `SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'wp_warmup'`,
    );
    expect(result.rows).toHaveLength(1);
    // BYPASSRLS is expected true here - asserted deliberately (not merely
    // tolerated) so a future change to it is loud: wp_warmup exists solely to
    // own wp_warmup_apply_tier_change, the writing SECURITY DEFINER function
    // that performs the tier-guarded UPDATE across whichever tenant is due
    // that tick, and cannot do its one job without it (migration 0034's own
    // header, "FIX SHAPE" section 2).
    expect(result.rows[0]).toMatchObject({ rolcanlogin: false, rolbypassrls: true });
  });

  it('wp_warmup_has_no_grant_beyond_instance_pacing_state_audit_logs_and_pacing_events', async () => {
    const pool = await getMigratedPool();

    // information_schema.role_column_grants reports EVERY grant expanded to
    // one row per column - a column-narrowed GRANT (instance_pacing_state)
    // AND a plain table-level GRANT (audit_logs/pacing_events INSERT) both
    // land here, just with a partial vs. full column list (verified live -
    // see grants-canonical.ts's own doc comment for the same distinction).
    // It is therefore the single canonical source for "every table this role
    // can touch" - role_table_grants alone would miss the column-scoped
    // instance_pacing_state grants entirely.
    const columnGrants = await pool.query<{
      table_name: string;
      privilege_type: string;
      column_name: string;
    }>(
      `SELECT table_name, privilege_type, column_name FROM information_schema.role_column_grants
        WHERE grantee = 'wp_warmup' AND table_schema = 'public'
        ORDER BY table_name, privilege_type, column_name`,
    );
    const tableNames = [...new Set(columnGrants.rows.map((row) => row.table_name))].sort();
    expect(tableNames).toEqual(['audit_logs', 'instance_pacing_state', 'pacing_events']);

    const privilegesByTable = (tableName: string): string[] =>
      [
        ...new Set(
          columnGrants.rows
            .filter((row) => row.table_name === tableName)
            .map((row) => row.privilege_type),
        ),
      ].sort();
    expect(privilegesByTable('instance_pacing_state')).toEqual(['SELECT', 'UPDATE']);
    expect(privilegesByTable('audit_logs')).toEqual(['INSERT']);
    expect(privilegesByTable('pacing_events')).toEqual(['INSERT']);

    // audit_logs/pacing_events are plain (non-column-scoped) table grants in
    // migration 0034, so every column of each table must be covered - a
    // narrowed subset here would mean a future migration accidentally
    // switched them to column-scoped grants.
    for (const fullTable of ['audit_logs', 'pacing_events']) {
      const grantedColumnCount = columnGrants.rows.filter(
        (row) => row.table_name === fullTable,
      ).length;
      const actualColumnCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [fullTable],
      );
      expect(grantedColumnCount, fullTable).toBe(Number(actualColumnCount.rows[0]?.count));
    }

    for (const forbiddenTable of [
      'wallet_accounts',
      'whatsapp_session_credentials',
      'auth_sessions',
      'message_jobs',
      'send_attempts',
    ]) {
      const forbiddenColumns = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.role_column_grants
          WHERE grantee = 'wp_warmup' AND table_schema = 'public' AND table_name = $1`,
        [forbiddenTable],
      );
      expect(forbiddenColumns.rows[0]?.count, forbiddenTable).toBe('0');

      const forbiddenTableLevel = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.role_table_grants
          WHERE grantee = 'wp_warmup' AND table_schema = 'public' AND table_name = $1`,
        [forbiddenTable],
      );
      expect(forbiddenTableLevel.rows[0]?.count, forbiddenTable).toBe('0');
    }

    // wp_warmup must never be granted to any other role (it is not a
    // membership group - it exists purely to be a function owner, same
    // proof shape as wp-reaper-role.test.ts).
    const memberships = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid
        WHERE r.rolname = 'wp_warmup'`,
    );
    expect(memberships.rows[0]?.count).toBe('0');

    // instance_pacing_state SELECT/UPDATE must be column-scoped to exactly
    // the columns migration 0034 grants - the exact narrow set
    // wp_warmup_apply_tier_change's own SELECT (inside a COALESCE)/UPDATE
    // statements touch, never status/id/anything outside the
    // pacing-effective-value surface.
    const columnsFor = (privilege: string): string[] =>
      columnGrants.rows
        .filter(
          (row) => row.table_name === 'instance_pacing_state' && row.privilege_type === privilege,
        )
        .map((row) => row.column_name)
        .sort();
    expect(columnsFor('SELECT')).toEqual(
      [
        'instance_id',
        'client_id',
        'warmup_tier',
        'config_version',
        'eff_window_start_local',
        'eff_window_end_local',
      ].sort(),
    );
    expect(columnsFor('UPDATE')).toEqual(
      [
        'eff_daily_cap',
        'eff_hourly_cap',
        'eff_new_conv_cap',
        'eff_gap_min_ms',
        'eff_gap_max_ms',
        'eff_cold_ratio_max',
        'eff_cold_ratio_floor',
        'eff_window_start_local',
        'eff_window_end_local',
        'eff_group_daily_cap',
        'config_version',
        'updated_at',
        'warmup_tier',
        'warmup_tier_since',
      ].sort(),
    );
  });
});
