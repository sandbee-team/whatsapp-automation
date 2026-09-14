import { afterAll, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import { fetchFunctionAttributes } from './helpers/grants.js';

/**
 * db/tests/wp-warmup-definer.test.ts (P13a re-review, finding 1) - split out
 * as a sibling of grants-snapshot.test.ts (max-lines cap, same idiom as
 * reaper-definer.test.ts / wp-reaper-role.test.ts): pins the EXECUTE-grantee
 * list for BOTH migration 0034 functions, mirroring the existing
 * wp_lease_scan_unowned (grants-snapshot.test.ts:204 pre-split) and
 * wp_session_bootstrap_scan blocks, and the
 * only_wp_scheduler_may_execute_the_definer_functions idiom in
 * reaper-definer.test.ts:125. The owner always implicitly retains EXECUTE
 * regardless of explicit grants (verified against every definer function in
 * this schema), so "wp_scheduler only" is proven by asserting the grantee
 * list is EXACTLY [<owner>, wp_scheduler] - wp_app and PUBLIC absent.
 */
describe('wp_warmup_definer_functions', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('wp_warmup_scan_due_is_definer_owned_by_the_bypassrls_role_with_a_pinned_search_path_and_scheduler_only_execute', async () => {
    const pool = await getMigratedPool();
    const functions = await fetchFunctionAttributes(pool);
    const scanFn = functions.find((fn) => fn.proname === 'wp_warmup_scan_due');

    expect(scanFn).toBeDefined();
    expect(scanFn?.prosecdef).toBe(true);
    expect(scanFn?.owner).toBe('wp_admin_app');

    const searchPathEntry = scanFn?.proconfig?.find((entry) => entry.startsWith('search_path='));
    expect(searchPathEntry).toBeDefined();
    expect(searchPathEntry).toContain('pg_catalog');

    const execGrants = await pool.query<{ grantee: string }>(
      `SELECT grantee FROM information_schema.role_routine_grants WHERE routine_name = 'wp_warmup_scan_due'`,
    );
    expect(execGrants.rows.map((row) => row.grantee).sort()).toEqual([
      'wp_admin_app',
      'wp_scheduler',
    ]);

    const publicGrant = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.role_routine_grants
        WHERE routine_name = 'wp_warmup_scan_due' AND grantee = 'PUBLIC'`,
    );
    expect(publicGrant.rows[0]?.count).toBe('0');
  });

  it('wp_warmup_apply_tier_change_is_definer_owned_by_wp_warmup_with_a_pinned_search_path_and_scheduler_only_execute', async () => {
    const pool = await getMigratedPool();
    const functions = await fetchFunctionAttributes(pool);
    const applyFn = functions.find((fn) => fn.proname === 'wp_warmup_apply_tier_change');

    expect(applyFn).toBeDefined();
    expect(applyFn?.prosecdef).toBe(true);
    expect(applyFn?.owner).toBe('wp_warmup');

    const searchPathEntry = applyFn?.proconfig?.find((entry) => entry.startsWith('search_path='));
    expect(searchPathEntry).toBeDefined();
    expect(searchPathEntry).toContain('pg_catalog');

    const execGrants = await pool.query<{ grantee: string }>(
      `SELECT grantee FROM information_schema.role_routine_grants WHERE routine_name = 'wp_warmup_apply_tier_change'`,
    );
    expect(execGrants.rows.map((row) => row.grantee).sort()).toEqual(['wp_scheduler', 'wp_warmup']);

    const publicGrant = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.role_routine_grants
        WHERE routine_name = 'wp_warmup_apply_tier_change' AND grantee = 'PUBLIC'`,
    );
    expect(publicGrant.rows[0]?.count).toBe('0');
  });
});
