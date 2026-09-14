import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { wrapAsRole } from '../../../platform/db/test-support/wp-app-role.js';
import { signup } from '../../identity/index.js';
import { loadAuthzSnapshot, type AuthzSnapshotRow } from '../authz.repo.js';

/**
 * `loadAuthzSnapshot` takes a plain `TenantQueryable` (`.query()` only, no
 * `BEGIN`/`COMMIT` of its own - it's called every tick without opening a
 * fresh transaction per call) while `wrapAsRole` returns a connect-based
 * pool (`SET LOCAL ROLE` only takes effect for the lifetime of one
 * transaction). This helper bridges the two: opens one connection, runs
 * `BEGIN` (which `wrapAsRole`'s wrapped `query` uses as the trigger to `SET
 * LOCAL ROLE wp_app`), calls `loadAuthzSnapshot` against that connection,
 * then `COMMIT`s and releases - exactly the shape the real authz-tick.ts
 * would need if it ever ran as wp_app inside a short-lived transaction
 * (today it runs on the plain pool - see roles/api.ts - this proof exists
 * to show the SAME query also works correctly under wp_app + FORCE RLS,
 * which is the role/RLS boundary this proof is about).
 */
async function loadAuthzSnapshotAsWpApp(
  wpApp: ReturnType<typeof wrapAsRole>,
  userIds: readonly string[],
): Promise<AuthzSnapshotRow[]> {
  const client = await wpApp.connect();
  try {
    await client.query('BEGIN');
    const rows = await loadAuthzSnapshot(client, userIds);
    await client.query('COMMIT');
    return rows;
  } finally {
    client.release();
  }
}

/**
 * authz-under-wp-app-role.integration.test.ts (P05 Unit U3b, THE RLS PROOF
 * for the realtime authz tick). `memberships`/`clients` are FORCE RLS
 * (migration 0005) and the api runs as `wp_app` (no BYPASSRLS) - this file
 * proves `public.wp_realtime_authz_snapshot` (migration 0017, SECURITY
 * DEFINER) reads across MANY users/clients in ONE statement under `wp_app`
 * with NO `app.client_id` GUC set (the authz tick has no single-tenant
 * context - it is deciding across many clients' users at once), and that a
 * DIRECT read of `memberships` under the same role/GUC state returns ZERO
 * rows regardless of real data (why the definer function exists at all).
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

function uniqueEmail(label: string): string {
  return `wp-app-realtime-authz-${label}-${randomUUID()}@example.test`;
}

async function seedClient(label: string): Promise<{ userId: string; clientId: string }> {
  const result = await signup(
    {
      tenantDb,
      sendVerificationEmail: async () => {},
      publicBaseUrl: 'http://localhost:5173',
      signupCreditMinor: 10000,
      lowBalanceThresholdMinor: 500,
    },
    {
      fullName: `WP App Realtime Authz ${label}`,
      email: uniqueEmail(label),
      companyName: `WP App Realtime Authz Co ${label}`,
    },
  );
  createdUserIds.push(result.userId);
  createdClientIds.push(result.clientId);
  // signup() creates the client as 'pending_verification' - bump to
  // 'active' (superuser, out of this proof's scope - identity's own
  // activation path is proven elsewhere) so client_status assertions below
  // have a non-default value to check.
  await pool.query(`UPDATE clients SET status = 'active' WHERE id = $1`, [result.clientId]);
  return { userId: result.userId, clientId: result.clientId };
}

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  if (createdClientIds.length > 0) {
    await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM wallet_ledger_ext_refs WHERE client_id = ANY($1)', [
      createdClientIds,
    ]);
    await pool.query('DELETE FROM wallet_ledger WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM client_pricing WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM memberships WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [createdClientIds]);
  }
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM email_verification_tokens WHERE user_id = ANY($1)', [
      createdUserIds,
    ]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

describe('realtime authz snapshot under wp_app + FORCE RLS (P05 Unit U3b - THE PROOF)', () => {
  it('the_authz_snapshot_reads_all_connected_users_in_one_statement_as_wp_app', async () => {
    const clientA = await seedClient('a');
    const clientB = await seedClient('b');
    // A second user in clientA's workspace - out of scope to add via a real
    // "invite" flow (not yet built); a direct superuser INSERT into
    // memberships is equivalent seeding for this proof, same precedent
    // used by other P05/P04b integration fixtures that need multi-user
    // clients.
    const secondUserResult = await signup(
      {
        tenantDb,
        sendVerificationEmail: async () => {},
        publicBaseUrl: 'http://localhost:5173',
        signupCreditMinor: 10000,
        lowBalanceThresholdMinor: 500,
      },
      {
        fullName: 'WP App Realtime Authz a2',
        email: uniqueEmail('a2-solo'),
        companyName: 'WP App Realtime Authz a2 Solo Co',
      },
    );
    createdUserIds.push(secondUserResult.userId);
    createdClientIds.push(secondUserResult.clientId);
    // Re-point this user's own (solo, signup-created) membership row onto
    // clientA's workspace instead - `memberships_one_workspace_per_user_uq`
    // (migration 0002) allows at most one membership row per user, so this
    // UPDATE (not a second INSERT) is how a superuser fixture gives clientA
    // a second member. The user's own solo-signup client row is left in
    // place (now membership-less) and cleaned up normally via
    // createdClientIds below - deleting it here would violate
    // client_pricing's FK to clients.
    await pool.query(`UPDATE memberships SET client_id = $2 WHERE user_id = $1`, [
      secondUserResult.userId,
      clientA.clientId,
    ]);

    const wpApp = wrapAsRole(pool, 'wp_app');

    // ONE statement, three users across two clients, wp_app with NO
    // app.client_id GUC set at all.
    const rows = await loadAuthzSnapshotAsWpApp(wpApp, [
      clientA.userId,
      secondUserResult.userId,
      clientB.userId,
    ]);

    expect(rows).toHaveLength(3);
    const byUserId = new Map(rows.map((r) => [r.userId, r]));

    const rowA = byUserId.get(clientA.userId);
    expect(rowA?.clientId).toBe(clientA.clientId);
    expect(rowA?.clientStatus).toBe('active');
    expect(rowA?.tokenEpoch).toBe(0);

    const rowA2 = byUserId.get(secondUserResult.userId);
    expect(rowA2?.clientId).toBe(clientA.clientId);
    expect(rowA2?.clientStatus).toBe('active');

    const rowB = byUserId.get(clientB.userId);
    expect(rowB?.clientId).toBe(clientB.clientId);
    expect(rowB?.clientStatus).toBe('active');

    // Membership removed for one user (superuser, direct) - their row must
    // now carry a NULL client_id (that IS the "membership revoked" signal),
    // not simply be absent.
    await pool.query('DELETE FROM memberships WHERE user_id = $1', [secondUserResult.userId]);

    const rowsAfterRevoke = await loadAuthzSnapshotAsWpApp(wpApp, [secondUserResult.userId]);
    expect(rowsAfterRevoke).toHaveLength(1);
    expect(rowsAfterRevoke[0]!.clientId).toBeNull();
    expect(rowsAfterRevoke[0]!.clientStatus).toBeNull();

    // Epoch bump for another user (superuser, direct) is reflected.
    await pool.query('UPDATE users SET token_epoch = token_epoch + 1 WHERE id = $1', [
      clientB.userId,
    ]);
    const rowsAfterEpochBump = await loadAuthzSnapshotAsWpApp(wpApp, [clientB.userId]);
    expect(rowsAfterEpochBump).toHaveLength(1);
    expect(rowsAfterEpochBump[0]!.tokenEpoch).toBe(1);

    // Direct read of memberships under wp_app with no app.client_id GUC
    // returns ZERO rows even though clientA's membership rows plainly still
    // exist - this is exactly why loadAuthzSnapshot must go through the
    // SECURITY DEFINER function rather than a plain SELECT.
    const wpAppClient = await wpApp.connect();
    try {
      await wpAppClient.query('BEGIN');
      const direct = await wpAppClient.query<{ client_id: string }>(
        'SELECT client_id FROM memberships WHERE user_id = ANY($1)',
        [[clientA.userId, clientB.userId]],
      );
      expect(direct.rows).toHaveLength(0);
      await wpAppClient.query('COMMIT');
    } finally {
      wpAppClient.release();
    }
  });
});
