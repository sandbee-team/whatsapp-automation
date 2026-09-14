import { afterAll, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * db/tests/wp-relay-role.test.ts (P15 C1 FIX F4 / MAJ-2) - the `wp_relay`
 * role's own shape in isolation, same mold as `wp-reaper-role.test.ts`. Pins
 * exactly the grant surface migrations 0041/0042 grant it and asserts no
 * grant exists beyond that set - `wp_relay` was OMITTED from
 * `grants.ts`'s `SNAPSHOT_ROLES` entirely at U1/U5 close, so its whole grant
 * surface was previously UNPINNED by the checked-in snapshot (a stale claim
 * it was captured - the snapshot held zero wp_relay rows).
 *
 * P17 (notifications-and-instance-card) Unit U1, migration 0048: the
 * containment set widens from four tables to five - `notifications` SELECT
 * is added (the email relay leg renders the email body from the
 * notification row, phase step 4). This is a DELIBERATE, task-instructed
 * widening, not a regression of the "must never gain a grant on a fifth
 * table" discipline migration 0046's header stated for an UNRELATED P16
 * need - that note guarded against incidental scope creep, not a real,
 * phase-scoped new read path. `memberships`/`users` remain UNGRANTED - see
 * migration 0048's own header "WP_RELAY GAP" note for why that decision is
 * deferred to the later unit that builds the actual email dispatcher.
 *
 * P17 follow-up, migration 0049: that gap is now resolved WITHOUT widening
 * wp_relay's table grants - two narrow SECURITY DEFINER functions
 * (`wp_notification_email_recipients`, `wp_notification_instance_label`)
 * project only the columns the relay's email leg needs, and wp_relay's
 * EXECUTE on exactly those two functions is pinned below, alongside the
 * unchanged table-grant containment set (still five tables - this
 * migration adds no new table grant to wp_relay at all).
 */
describe('wp_relay_role', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('wp_relay_cannot_log_in_and_has_bypassrls', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ rolcanlogin: boolean; rolbypassrls: boolean }>(
      `SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'wp_relay'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ rolcanlogin: false, rolbypassrls: true });
  });

  it('wp_relay_holds_exactly_the_outbox_events_grants_from_migrations_0041_and_0042', async () => {
    const pool = await getMigratedPool();
    const grants = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'wp_relay' AND table_schema = 'public' AND table_name = 'outbox_events'
        ORDER BY privilege_type`,
    );
    const privileges = grants.rows.map((row) => row.privilege_type).sort();
    // SELECT/UPDATE/DELETE from 0041, INSERT from 0042.
    expect(privileges).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('wp_relay_holds_exactly_select_insert_update_on_webhook_deliveries', async () => {
    const pool = await getMigratedPool();
    const grants = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'wp_relay' AND table_schema = 'public' AND table_name = 'webhook_deliveries'
        ORDER BY privilege_type`,
    );
    const privileges = grants.rows.map((row) => row.privilege_type).sort();
    expect(privileges).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });

  it('wp_relay_holds_select_plus_exactly_the_four_health_columns_column_scoped_update_on_webhook_endpoints', async () => {
    const pool = await getMigratedPool();

    // Table-level: SELECT only (the column-scoped UPDATE never produces a
    // role_table_grants row - same distinction wp-reaper-role.test.ts
    // documents).
    const tableGrants = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'wp_relay' AND table_schema = 'public' AND table_name = 'webhook_endpoints'
        ORDER BY privilege_type`,
    );
    expect(tableGrants.rows.map((row) => row.privilege_type)).toEqual(['SELECT']);

    // Column-scoped UPDATE: exactly last_success_at/consecutive_failures/
    // disabled_reason/enabled - never url/secret_enc/events/
    // include_message_body (those stay wp_app-only, migration 0041's own
    // header, verbatim).
    const updateColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.role_column_grants
        WHERE grantee = 'wp_relay' AND table_schema = 'public' AND table_name = 'webhook_endpoints'
          AND privilege_type = 'UPDATE'
        ORDER BY column_name`,
    );
    expect(updateColumns.rows.map((row) => row.column_name)).toEqual([
      'consecutive_failures',
      'disabled_reason',
      'enabled',
      'last_success_at',
    ]);
  });

  it('wp_relay_holds_insert_only_on_audit_logs', async () => {
    const pool = await getMigratedPool();
    const grants = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'wp_relay' AND table_schema = 'public' AND table_name = 'audit_logs'
        ORDER BY privilege_type`,
    );
    expect(grants.rows.map((row) => row.privilege_type)).toEqual(['INSERT']);
  });

  it('wp_relay_holds_exactly_select_on_notifications', async () => {
    const pool = await getMigratedPool();
    const grants = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'wp_relay' AND table_schema = 'public' AND table_name = 'notifications'
        ORDER BY privilege_type`,
    );
    expect(grants.rows.map((row) => row.privilege_type)).toEqual(['SELECT']);
  });

  it('wp_relay_has_no_grant_on_any_table_beyond_the_five_it_owns', async () => {
    const pool = await getMigratedPool();
    const grants = await pool.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.role_table_grants
        WHERE grantee = 'wp_relay' AND table_schema = 'public'
        ORDER BY table_name`,
    );
    expect(grants.rows.map((row) => row.table_name)).toEqual([
      'audit_logs',
      'notifications',
      'outbox_events',
      'webhook_deliveries',
      'webhook_endpoints',
    ]);

    // wp_relay must never be granted to any other role (not a membership
    // group - same discipline wp-reaper-role.test.ts asserts).
    const memberships = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid
        WHERE r.rolname = 'wp_relay'`,
    );
    expect(memberships.rows[0]?.count).toBe('0');
  });

  it('wp_relay_holds_exactly_the_two_notification_dispatch_definer_function_execute_grants', async () => {
    const pool = await getMigratedPool();
    const grants = await pool.query<{ routine_name: string; grantee: string }>(
      `SELECT routine_name, grantee FROM information_schema.role_routine_grants
        WHERE routine_name IN ('wp_notification_email_recipients', 'wp_notification_instance_label')
        ORDER BY routine_name, grantee`,
    );

    // The owner (wp_admin_app) always implicitly retains EXECUTE regardless
    // of explicit grants (same "owner always appears" note the
    // wp_lease_scan_unowned/wp_session_bootstrap_scan tests in
    // grants-snapshot.test.ts document) - "wp_relay only" means no OTHER
    // role beyond the owner, not a bare single-row grantee list.
    const byFunction = new Map<string, string[]>();
    for (const row of grants.rows) {
      const grantees = byFunction.get(row.routine_name) ?? [];
      grantees.push(row.grantee);
      byFunction.set(row.routine_name, grantees);
    }
    expect(byFunction.get('wp_notification_email_recipients')?.sort()).toEqual([
      'wp_admin_app',
      'wp_relay',
    ]);
    expect(byFunction.get('wp_notification_instance_label')?.sort()).toEqual([
      'wp_admin_app',
      'wp_relay',
    ]);

    const publicGrant = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.role_routine_grants
        WHERE routine_name IN ('wp_notification_email_recipients', 'wp_notification_instance_label')
          AND grantee = 'PUBLIC'`,
    );
    expect(publicGrant.rows[0]?.count).toBe('0');
  });
});
