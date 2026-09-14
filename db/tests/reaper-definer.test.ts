import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import {
  cleanupReaperProbeClients,
  insertProcessingJob,
  type PgError,
  type ReapedRow,
} from './helpers/reaper-fixtures.js';

/**
 * db/tests/reaper-definer.test.ts (P12 U2a) - proves
 * `db/migrations/0027_reaper_and_reconcile_definer_functions.sql`'s
 * FUNCTION-level surface against the REAL database: the blocker itself,
 * the limit-bounded batch size, grace/limit validation, EXECUTE-grant
 * narrowing, and ownership. Split, at the max-lines cap, into three sibling
 * files sharing `helpers/reaper-fixtures.ts`:
 *   - `reaper-repair-contract.test.ts` - the BEHAVIORAL contract (two-tenant
 *     single pass, the grace boundary, the four-state repair contract, the
 *     reconciler's read-only cross-tenant scan).
 *   - `wp-reaper-role.test.ts` - the `wp_reaper` ROLE's own shape
 *     (NOLOGIN/BYPASSRLS, no grant beyond message_jobs/send_attempts, no
 *     leftover artifact from the founder's pre-migration design spike).
 *
 * No sleeps anywhere - every timestamp is seeded relative to SQL's own
 * `now()` (see .claude/rules/core-invariants.md "Tests must not assert on
 * ambient state").
 */
describe('reaper_definer', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    await cleanupReaperProbeClients(probeClientIds);
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  it('wp_scheduler_sees_zero_message_jobs_rows_without_the_definer_function', async () => {
    const pool = await getMigratedPool();
    const clientId = randomUUID();
    const instanceId = randomUUID();
    probeClientIds.push(clientId);

    await insertProcessingJob({
      clientId,
      instanceId,
      leaseExpiresAtSql: "now() - interval '1 minute'",
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');
      const result = await client.query('SELECT count(*)::int AS count FROM message_jobs');
      expect(result.rows[0]).toMatchObject({ count: 0 });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('the_reaper_definer_is_bounded_by_its_limit_parameter', async () => {
    const pool = await getMigratedPool();
    const clientId = randomUUID();
    const instanceId = randomUUID();
    probeClientIds.push(clientId);

    const n = 3;
    for (let i = 0; i < n + 2; i += 1) {
      await insertProcessingJob({
        clientId,
        instanceId,
        leaseExpiresAtSql: "now() - interval '1 minute'",
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');
      const result = await client.query<ReapedRow>('SELECT * FROM wp_reap_expired_leases($1, $2)', [
        30,
        n,
      ]);
      await client.query('COMMIT');
      expect(result.rows).toHaveLength(n);
    } finally {
      client.release();
    }
  });

  it('the_reaper_definer_rejects_an_invalid_limit_or_grace', async () => {
    const pool = await getMigratedPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');

      await expect(
        client.query('SELECT * FROM wp_reap_expired_leases($1, $2)', [30, 0]),
      ).rejects.toMatchObject<Partial<PgError>>({ code: 'P0001' });
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');

      await expect(
        client.query('SELECT * FROM wp_reap_expired_leases($1, $2)', [30, 5001]),
      ).rejects.toMatchObject<Partial<PgError>>({ code: 'P0001' });
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');

      await expect(
        client.query('SELECT * FROM wp_reap_expired_leases($1, $2)', [-1, 500]),
      ).rejects.toMatchObject<Partial<PgError>>({ code: 'P0001' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('only_wp_scheduler_may_execute_the_definer_functions', async () => {
    const pool = await getMigratedPool();

    // Both functions' OWNERS (wp_reaper for the writer, wp_admin_app for the
    // reader - see the migration header) always implicitly retain EXECUTE
    // regardless of explicit grants (same as every existing definer function
    // in this schema - see grants-snapshot.test.ts's wp_lease_scan_unowned/
    // wp_session_bootstrap_scan cases). "scheduler only" is therefore proven
    // below by asserting each function's EXECUTE grantee list is EXACTLY
    // [<its own owner>, wp_scheduler] with nobody else, not by trying to
    // make the owner's own call fail.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_app');
      await expect(
        client.query('SELECT * FROM wp_reap_expired_leases($1, $2)', [30, 500]),
      ).rejects.toMatchObject<Partial<PgError>>({ code: '42501' });
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_app');
      await expect(
        client.query('SELECT * FROM wp_reconcile_scan_unresolved($1, $2, $3)', [3600, 300, 500]),
      ).rejects.toMatchObject<Partial<PgError>>({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const expectedGranteesByFn: Record<string, string[]> = {
      wp_reap_expired_leases: ['wp_reaper', 'wp_scheduler'],
      wp_reconcile_scan_unresolved: ['wp_admin_app', 'wp_scheduler'],
    };
    for (const [fn, expectedGrantees] of Object.entries(expectedGranteesByFn)) {
      const execGrants = await pool.query<{ grantee: string }>(
        `SELECT grantee FROM information_schema.role_routine_grants WHERE routine_name = $1`,
        [fn],
      );
      expect(execGrants.rows.map((row) => row.grantee).sort()).toEqual(expectedGrantees.sort());

      const publicGrant = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.role_routine_grants
          WHERE routine_name = $1 AND grantee = 'PUBLIC'`,
        [fn],
      );
      expect(publicGrant.rows[0]?.count).toBe('0');
    }
  });

  it('the_definer_functions_are_owned_by_the_correct_bypassrls_role_with_a_pinned_search_path', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{
      proname: string;
      owner: string;
      prosecdef: boolean;
      proconfig: string[] | null;
    }>(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('wp_reap_expired_leases', 'wp_reconcile_scan_unresolved')
        ORDER BY p.proname`,
    );
    expect(result.rows).toHaveLength(2);
    // wp_reap_expired_leases (the writer) is owned by wp_reaper;
    // wp_reconcile_scan_unresolved (read-only) stays on the original
    // precedent shape, owned by wp_admin_app - see the migration header.
    const expectedOwnerByFn: Record<string, string> = {
      wp_reap_expired_leases: 'wp_reaper',
      wp_reconcile_scan_unresolved: 'wp_admin_app',
    };
    for (const row of result.rows) {
      expect(row.owner, row.proname).toBe(expectedOwnerByFn[row.proname]);
      expect(row.prosecdef, row.proname).toBe(true);
      const searchPathEntry = row.proconfig?.find((entry) => entry.startsWith('search_path='));
      expect(searchPathEntry, row.proname).toBeDefined();
      expect(searchPathEntry, row.proname).toContain('pg_catalog');
    }
  });
});
