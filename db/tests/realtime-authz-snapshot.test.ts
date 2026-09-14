import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { fetchFunctionAttributes } from './helpers/grants.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * P05 (panel-shell-and-sse) Unit U0 - db/migrations/0017_realtime_authz_snapshot.sql.
 * Sibling of identity-definer-helpers-schema.test.ts (migration 0015), same
 * conventions: definer-owned by the BYPASSRLS role, pinned search_path,
 * EXECUTE granted to exactly wp_app and NOT to PUBLIC or wp_scheduler.
 *
 * Seeded rows are created as the superuser (`wp`, bypasses RLS/grants) and
 * removed in `afterEach` in reverse-FK order, matching tenant-db.test.ts.
 */
describe('realtime_authz_snapshot', () => {
  let probeUserIds: string[] = [];
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    if (probeClientIds.length > 0) {
      await pool.query('DELETE FROM memberships WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    }
    if (probeUserIds.length > 0) {
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [probeUserIds]);
    }
    probeUserIds = [];
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  async function createProbeUser(tokenEpoch = 0): Promise<string> {
    const pool = await getMigratedPool();
    const userId = randomUUID();
    await pool.query(
      'INSERT INTO users (id, full_name, email, token_epoch) VALUES ($1, $2, $3, $4)',
      [userId, 'Realtime Authz Probe', `realtime-authz-probe-${userId}@example.com`, tokenEpoch],
    );
    probeUserIds.push(userId);
    return userId;
  }

  async function createProbeClient(status: 'active' | 'suspended' = 'active'): Promise<string> {
    const pool = await getMigratedPool();
    const clientId = randomUUID();
    await pool.query(
      'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
      [clientId, 'Realtime Authz Probe Client', `realtime-authz-probe-${clientId}`, status],
    );
    probeClientIds.push(clientId);
    return clientId;
  }

  async function addMembership(clientId: string, userId: string): Promise<void> {
    const pool = await getMigratedPool();
    await pool.query('INSERT INTO memberships (client_id, user_id, role) VALUES ($1, $2, $3)', [
      clientId,
      userId,
      'owner',
    ]);
  }

  it('wp_app_can_read_a_realtime_authz_snapshot_across_tenants_via_the_definer', async () => {
    const pool = await getMigratedPool();

    const clientA = await createProbeClient('active');
    const clientB = await createProbeClient('active');
    const userA = await createProbeUser(3);
    const userB = await createProbeUser(7);
    await addMembership(clientA, userA);
    await addMembership(clientB, userB);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_app');

      // Proves the definer is necessary, not decorative: a plain SELECT
      // against the RLS-protected table under wp_app with no
      // app.client_id GUC set returns zero rows for everyone.
      const plainSelect = await client.query('SELECT * FROM memberships WHERE user_id = ANY($1)', [
        [userA, userB],
      ]);
      expect(plainSelect.rows).toEqual([]);

      const result = await client.query<{
        user_id: string;
        token_epoch: number;
        client_id: string | null;
        client_status: string | null;
      }>('SELECT * FROM wp_realtime_authz_snapshot($1)', [[userA, userB]]);

      await client.query('ROLLBACK');

      const byUser = new Map(result.rows.map((row) => [row.user_id, row]));
      expect(result.rows).toHaveLength(2);
      expect(byUser.get(userA)).toMatchObject({
        token_epoch: 3,
        client_id: clientA,
        client_status: 'active',
      });
      expect(byUser.get(userB)).toMatchObject({
        token_epoch: 7,
        client_id: clientB,
        client_status: 'active',
      });
    } finally {
      client.release();
    }
  });

  it('a_user_without_a_membership_still_returns_a_row_with_null_client_id', async () => {
    const pool = await getMigratedPool();
    const userId = await createProbeUser(1);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_app');

      const result = await client.query<{
        user_id: string;
        token_epoch: number;
        client_id: string | null;
        client_status: string | null;
      }>('SELECT * FROM wp_realtime_authz_snapshot($1)', [[userId]]);

      await client.query('ROLLBACK');

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ user_id: userId, token_epoch: 1, client_id: null });
      expect(result.rows[0]?.client_status).toBeNull();
    } finally {
      client.release();
    }
  });

  it('a_nonexistent_user_id_returns_no_row', async () => {
    const pool = await getMigratedPool();
    const missingUserId = randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_app');

      const result = await client.query('SELECT * FROM wp_realtime_authz_snapshot($1)', [
        [missingUserId],
      ]);

      await client.query('ROLLBACK');

      expect(result.rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('the_function_is_owned_by_wp_admin_app_and_executable_only_by_wp_app', async () => {
    const pool = await getMigratedPool();

    const functions = await fetchFunctionAttributes(pool);
    const fn = functions.find((f) => f.proname === 'wp_realtime_authz_snapshot');

    expect(fn, 'wp_realtime_authz_snapshot: function not found').toBeDefined();
    expect(fn?.prosecdef).toBe(true);
    expect(fn?.owner).toBe('wp_admin_app');

    const searchPathEntry = fn?.proconfig?.find((entry) => entry.startsWith('search_path='));
    expect(searchPathEntry).toBeDefined();
    expect(searchPathEntry).toContain('pg_catalog');

    const grantedRows = await pool.query<{ grantee: string }>(
      `SELECT DISTINCT grantee
         FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name = 'wp_realtime_authz_snapshot'
          AND privilege_type = 'EXECUTE'`,
    );
    const grantees = grantedRows.rows.map((row) => row.grantee);

    expect(grantees).toContain('wp_app');
    expect(grantees).not.toContain('wp_scheduler');
    expect(grantees).not.toContain('PUBLIC');
  });
});
