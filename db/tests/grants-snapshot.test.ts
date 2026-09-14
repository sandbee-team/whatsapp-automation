import { afterAll, describe, expect, it } from 'vitest';
import { getMigratedPool, closeMigratedPool } from './helpers/migrated-db.js';
import {
  fetchExistingTables,
  fetchFunctionAttributes,
  fetchLiveColumnGrantsForTables,
  fetchLiveGrantsForTables,
  fetchPartitionChildren,
  fetchRoleAttributes,
} from './helpers/grants.js';
import {
  fetchCanonicalGrantDump,
  serializeCanonicalGrantDump,
} from './helpers/grants-canonical.js';
import { SEND_PATH_TABLES } from '../src/isolation/tenant-tables.js';

/**
 * P02 step 10 - role-grant snapshot. `db/schema/grants.snapshot.json` is
 * the checked-in canonical dump of `information_schema.role_table_grants`
 * (public schema, the four wp_* roles) plus `pg_roles` attributes for those
 * roles, generated from the live migrated dev database.
 *
 * If migration 0005 (or a later grant migration) intentionally changes the
 * matrix, regenerate with:
 *   pnpm -F @wp/db exec vitest run tests/grants-snapshot.test.ts --update
 * A snapshot mismatch must never be silently accepted - only ever updated
 * after a deliberate, reviewed grant change.
 */
describe('grants_snapshot', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('role_table_grants_match_the_checked_in_snapshot', async () => {
    const pool = await getMigratedPool();
    const dump = await fetchCanonicalGrantDump(pool);

    await expect(serializeCanonicalGrantDump(dump)).toMatchFileSnapshot(
      '../schema/grants.snapshot.json',
    );
  });

  it('wp_app_cannot_update_or_delete_wallet_ledger', async () => {
    const pool = await getMigratedPool();

    const ledgerChildren = await fetchPartitionChildren(pool, 'wallet_ledger');
    const tables = ['wallet_ledger', 'wallet_ledger_ext_refs', ...ledgerChildren];

    const grants = await fetchLiveGrantsForTables(pool, 'wp_app', tables);

    const writeGrants = grants.filter(
      (row) => row.privilege_type === 'UPDATE' || row.privilege_type === 'DELETE',
    );
    expect(writeGrants).toEqual([]);

    // Guards against a vacuous pass: wp_app must actually hold the
    // append-only grants ADR 0019 SS1 requires, on both parent tables.
    for (const parent of ['wallet_ledger', 'wallet_ledger_ext_refs']) {
      const privileges = grants
        .filter((row) => row.table_name === parent)
        .map((row) => row.privilege_type);
      expect(privileges).toContain('INSERT');
      expect(privileges).toContain('SELECT');
    }
  });

  it('wp_app_does_not_have_bypassrls', async () => {
    const pool = await getMigratedPool();
    const roles = await fetchRoleAttributes(pool);
    const byName = new Map(roles.map((role) => [role.rolname, role]));

    expect(byName.get('wp_app')?.rolbypassrls).toBe(false);
    expect(byName.get('wp_migrator')?.rolbypassrls).toBe(false);
    expect(byName.get('wp_scheduler')?.rolbypassrls).toBe(false);
    expect(byName.get('wp_admin_app')?.rolbypassrls).toBe(true);
    // wp_reaper (migration 0027, P12 U2a) is DELIBERATELY BYPASSRLS - it
    // exists solely to own wp_reap_expired_leases, the first WRITING
    // cross-tenant SECURITY DEFINER function in this schema, and cannot do
    // its one job without it (see that migration's header for the full
    // rejected-alternatives analysis). It is also NOLOGIN (asserted in
    // db/tests/reaper-definer.test.ts's `wp_reaper_cannot_log_in`) and holds
    // no grant beyond message_jobs/send_attempts (asserted there too) - do
    // NOT "fix" this to false; that would break the reaper's only reason to
    // exist.
    expect(byName.get('wp_reaper')?.rolbypassrls).toBe(true);

    for (const name of ['wp_app', 'wp_migrator', 'wp_scheduler', 'wp_admin_app', 'wp_reaper']) {
      expect(byName.get(name)?.rolsuper).toBe(false);
    }
  });

  it('wp_admin_app_has_no_write_grant_on_any_existing_send_path_table', async () => {
    const pool = await getMigratedPool();

    const existing = await fetchExistingTables(pool, SEND_PATH_TABLES);

    // Non-vacuous today: wallet_accounts, wallet_ledger and
    // wallet_ledger_ext_refs already exist; the other SEND_PATH_TABLES
    // entries arrive in P03/P13/P18 and this test picks them up automatically.
    expect(existing.length).toBeGreaterThan(0);
    expect(existing).toEqual(
      expect.arrayContaining(['wallet_accounts', 'wallet_ledger', 'wallet_ledger_ext_refs']),
    );

    const childLists = await Promise.all(
      existing.map((tableName) => fetchPartitionChildren(pool, tableName)),
    );
    const allTables = [...existing, ...childLists.flat()];

    // Union TABLE-level and COLUMN-level grants (P03 close, finding 3):
    // role_table_grants alone would miss a future column-narrowed write
    // grant such as `GRANT UPDATE (status) ON message_jobs TO
    // wp_admin_app` - exactly the forbidden staff-resume mechanism (ADR
    // safety-compliance: no bypassing the fail-safe pause) - since that
    // grant never produces a role_table_grants row at all.
    const tableGrants = await fetchLiveGrantsForTables(pool, 'wp_admin_app', allTables);
    const columnGrants = await fetchLiveColumnGrantsForTables(pool, 'wp_admin_app', allTables);

    const writeTableGrants = tableGrants.filter((row) =>
      ['INSERT', 'UPDATE', 'DELETE'].includes(row.privilege_type),
    );
    const writeColumnGrants = columnGrants.filter((row) =>
      ['INSERT', 'UPDATE', 'DELETE'].includes(row.privilege_type),
    );

    expect(writeTableGrants).toEqual([]);
    expect(writeColumnGrants).toEqual([]);
  });

  it('the_boot_gate_function_is_definer_owned_by_the_bypassrls_role_with_a_pinned_search_path', async () => {
    const pool = await getMigratedPool();
    const functions = await fetchFunctionAttributes(pool);
    const bootGate = functions.find((fn) => fn.proname === 'wp_zero_max_rate_wallet_count');

    // Non-vacuous: the function must actually exist by the time this runs.
    expect(bootGate).toBeDefined();
    expect(bootGate?.prosecdef).toBe(true);
    expect(bootGate?.owner).toBe('wp_admin_app');

    // Guards against a future blanket REASSIGN OWNED (or a rewritten
    // CREATE OR REPLACE) silently dropping the pin and converting the ADR
    // 0019 SS1 boot gate into a fail-open no-op under FORCE ROW LEVEL
    // SECURITY (see migration 0005 section 4 / 0006 for why the pin
    // matters).
    const searchPathEntry = bootGate?.proconfig?.find((entry) => entry.startsWith('search_path='));
    expect(searchPathEntry).toBeDefined();
    expect(searchPathEntry).toContain('pg_catalog');
  });

  // P06 (session-lease-and-fence) - ADR 0029 SS4: wp_admin_app must never
  // gain a write grant on instance_lease_state (a staff-side write to
  // fence/liveness would be a session-takeover primitive).
  it('wp_admin_app_cannot_write_instance_lease_state', async () => {
    const pool = await getMigratedPool();

    const tableGrants = await fetchLiveGrantsForTables(pool, 'wp_admin_app', [
      'instance_lease_state',
    ]);
    const columnGrants = await fetchLiveColumnGrantsForTables(pool, 'wp_admin_app', [
      'instance_lease_state',
    ]);

    const writeTableGrants = tableGrants.filter((row) =>
      ['INSERT', 'UPDATE', 'DELETE'].includes(row.privilege_type),
    );
    const writeColumnGrants = columnGrants.filter((row) =>
      ['INSERT', 'UPDATE', 'DELETE'].includes(row.privilege_type),
    );

    expect(writeTableGrants).toEqual([]);
    expect(writeColumnGrants).toEqual([]);

    // Non-vacuous: wp_admin_app must still hold its read grant.
    const selectGrants = tableGrants.filter((row) => row.privilege_type === 'SELECT');
    expect(selectGrants.length).toBeGreaterThan(0);
  });

  // P06 - ADR 0029 SS2: the discovery-scan definer function, same hardening
  // shape as the boot-gate/identity definer functions above.
  it('the_lease_scan_function_is_definer_owned_by_the_bypassrls_role_with_a_pinned_search_path_and_scheduler_only_execute', async () => {
    const pool = await getMigratedPool();
    const functions = await fetchFunctionAttributes(pool);
    const scanFn = functions.find((fn) => fn.proname === 'wp_lease_scan_unowned');

    expect(scanFn).toBeDefined();
    expect(scanFn?.prosecdef).toBe(true);
    expect(scanFn?.owner).toBe('wp_admin_app');

    const searchPathEntry = scanFn?.proconfig?.find((entry) => entry.startsWith('search_path='));
    expect(searchPathEntry).toBeDefined();
    expect(searchPathEntry).toContain('pg_catalog');

    const execGrants = await pool.query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type
         FROM information_schema.role_routine_grants
        WHERE routine_name = 'wp_lease_scan_unowned'`,
    );
    // The owner (wp_admin_app) always implicitly retains EXECUTE regardless
    // of explicit grants (verified against every existing definer function
    // in this schema, e.g. wp_client_id_for_user/wp_realtime_authz_snapshot)
    // - "scheduler only" means no OTHER role beyond the owner, not a bare
    // single-row grantee list.
    const grantees = execGrants.rows.map((row) => row.grantee).sort();
    expect(grantees).toEqual(['wp_admin_app', 'wp_scheduler']);

    const publicGrant = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.role_routine_grants
        WHERE routine_name = 'wp_lease_scan_unowned' AND grantee = 'PUBLIC'`,
    );
    expect(publicGrant.rows[0]?.count).toBe('0');
  });

  // P08 Unit U3 (migration 0022) - ADR 0029 precedent applied to the
  // pairing-intent bootstrap discovery scan: same hardening shape as
  // wp_lease_scan_unowned above (definer, wp_admin_app-owned, pinned
  // search_path, scheduler-only EXECUTE).
  it('the_bootstrap_scan_function_is_definer_owned_by_the_bypassrls_role_with_a_pinned_search_path_and_scheduler_only_execute', async () => {
    const pool = await getMigratedPool();
    const functions = await fetchFunctionAttributes(pool);
    const scanFn = functions.find((fn) => fn.proname === 'wp_session_bootstrap_scan');

    expect(scanFn).toBeDefined();
    expect(scanFn?.prosecdef).toBe(true);
    expect(scanFn?.owner).toBe('wp_admin_app');

    const searchPathEntry = scanFn?.proconfig?.find((entry) => entry.startsWith('search_path='));
    expect(searchPathEntry).toBeDefined();
    expect(searchPathEntry).toContain('pg_catalog');

    const execGrants = await pool.query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type
         FROM information_schema.role_routine_grants
        WHERE routine_name = 'wp_session_bootstrap_scan'`,
    );
    const grantees = execGrants.rows.map((row) => row.grantee).sort();
    expect(grantees).toEqual(['wp_admin_app', 'wp_scheduler']);

    const publicGrant = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.role_routine_grants
        WHERE routine_name = 'wp_session_bootstrap_scan' AND grantee = 'PUBLIC'`,
    );
    expect(publicGrant.rows[0]?.count).toBe('0');
  });
});
