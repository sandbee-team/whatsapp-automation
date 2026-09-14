import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startU3cHarness, type U3cHarness } from './__tests__/internal-u3c-app-fixture.js';
import { grantAndMint } from './__tests__/internal-u3c-support.js';

/**
 * internal-impersonation-c2.integration.test.ts (P28 C2 hardening) - clock
 * boundaries and revoke-cascade cases not covered by
 * `internal-impersonation.integration.test.ts` / `internal-impersonation-
 * writes.integration.test.ts`: the exact 30-minute grant window, whether an
 * already-minted token can outlive its grant's own `expires_at` before the
 * next refresh, and that revoking a PARENT grant also revokes an elevation
 * CHILD spawned off it (not just the named grant).
 */

const SECRET = 'internal-u3c-impersonation-c2-test-secret-01';

let h: U3cHarness;

beforeAll(async () => {
  h = await startU3cHarness({
    secret: SECRET,
    applicationName: 'internal-u3c-impersonation-c2-tests',
  });
});

afterAll(async () => {
  await h.close();
});

describe('internal-impersonation-c2', () => {
  it('a_grant_with_durationMinutes_30_has_an_expires_at_exactly_thirty_minutes_after_created_at', async () => {
    const { clientId } = await h.seedOwnerTenant();
    const staffId = await h.seedStaff('superadmin');

    const grant = await h.sendInternal(
      'POST',
      `/internal/v1/clients/${clientId}/impersonation`,
      staffId,
      { reason: 'exact clock-boundary probe', durationMinutes: 30 },
    );
    expect(grant.statusCode).toBe(200);
    const grantId = (grant.json() as { data: { grantId: string } }).data.grantId;

    // Compare inside SQL, in seconds - the DB's own clock is the single
    // source of truth for both columns, so this is exact, not a wall-clock
    // margin measured from the test process.
    const interval = await h.pool.query<{ seconds: string }>(
      `SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::text AS seconds
         FROM impersonation_grants WHERE id = $1`,
      [grantId],
    );
    expect(Number(interval.rows[0]?.seconds)).toBe(30 * 60);
  });

  it('a_token_minted_before_grant_expiry_stays_valid_for_ordinary_requests_until_its_own_ttl_but_refresh_is_refused_once_the_grant_has_expired', async () => {
    const { clientId } = await h.seedOwnerTenant();
    const staffId = await h.seedStaff('superadmin');

    // Shortest legal grant duration is 1 minute (see the contract's own
    // `.min(1)`), minted immediately - the token itself carries its own
    // 2-minute TTL and is validated by JWT exp + token_epoch ALONE
    // (`validateAccessToken`), which does not re-read the grant row. Only
    // `/v1/auth/impersonation/refresh` re-reads `impersonation_grants` and
    // checks `expires_at`.
    const { accessToken } = await grantAndMint(h, staffId, clientId, { durationMinutes: 1 });

    // Immediately after minting, an ordinary authenticated call succeeds -
    // the grant is still active.
    const meImmediately = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meImmediately.statusCode).toBe(200);

    // Force the grant's `expires_at` into the past WITHOUT touching the
    // already-minted token (no revoke, no epoch bump) - this isolates the
    // exact question: does the STILL-VALID (unexpired JWT, unchanged epoch)
    // token keep working for ordinary requests once its OWN grant has
    // expired? Two CHECK constraints (migration 0070) bound how this can be
    // done: `impersonation_grants_expires_after_created`
    // (`expires_at > created_at`) and `impersonation_grants_max_thirty_minutes`
    // (`expires_at <= created_at + interval '30 minutes'`) - both columns
    // move together, a short distance apart, landing entirely in the past.
    await h.pool.query(
      // `SET` stays on the `UPDATE` line - the `wp/no-plain-set` guard
      // matches a line-leading `SET `, which a wrapped clause would trip
      // (same idiom as `routes/clients.ts#transitionClientStatus`).
      `UPDATE impersonation_grants SET created_at = now() - interval '2 minutes',
              expires_at = now() - interval '1 second'
        WHERE client_id = $1 AND revoked_at IS NULL`,
      [clientId],
    );

    const meAfterGrantExpiry = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    // FINDING TARGET: `validateAccessToken` only checks the JWT's own exp +
    // token_epoch, never the grant row, so an already-minted token DOES
    // outlive its grant's `expires_at` for ordinary requests until its own
    // 2-minute TTL elapses or an explicit revoke bumps the epoch. This
    // assertion documents that fact exactly as the code behaves; if it ever
    // flips to 401 that is a (welcome) behaviour change, not a break.
    expect(meAfterGrantExpiry.statusCode).toBe(200);

    // The ONE place expiry is actually enforced before the token's own TTL
    // is up: refresh re-reads the grant and refuses once it has expired.
    const refresh = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/impersonation/refresh',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(refresh.statusCode).toBe(401);
  });

  it('revoking_a_parent_grant_also_revokes_its_elevation_child_and_the_elevated_token_is_401', async () => {
    const { clientId } = await h.seedOwnerTenant();
    const staffId = await h.seedStaff('superadmin');

    const { grantId: parentGrantId } = await grantAndMint(h, staffId, clientId);

    const elevate = await h.sendInternal(
      'POST',
      `/internal/v1/impersonation/${parentGrantId}/elevate`,
      staffId,
      { reason: 'need message bodies for this ticket', durationMinutes: 10 },
    );
    expect(elevate.statusCode).toBe(200);
    const childGrantId = (elevate.json() as { data: { grantId: string } }).data.grantId;

    const mintChild = await h.sendInternal(
      'POST',
      `/internal/v1/impersonation/${childGrantId}/token`,
      staffId,
      { reason: 'mint elevated session token' },
    );
    expect(mintChild.statusCode).toBe(200);
    const elevatedToken = (mintChild.json() as { data: { accessToken: string } }).data.accessToken;

    const meBeforeRevoke = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${elevatedToken}` },
    });
    expect(meBeforeRevoke.statusCode).toBe(200);

    // Revoke the PARENT grant only - never touch the child directly.
    const revoke = await h.sendInternal(
      'POST',
      `/internal/v1/impersonation/${parentGrantId}/revoke`,
      staffId,
      { reason: 'investigation complete, revoking the whole chain' },
    );
    expect(revoke.statusCode).toBe(200);

    const rows = await h.pool.query<{ id: string; revoked_at: string | null }>(
      `SELECT id, revoked_at::text AS revoked_at FROM impersonation_grants
        WHERE id = ANY($1)`,
      [[parentGrantId, childGrantId]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row.revoked_at]));
    expect(byId.get(parentGrantId)).not.toBeNull();
    expect(byId.get(childGrantId)).not.toBeNull();

    const meAfterRevoke = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${elevatedToken}` },
    });
    expect(meAfterRevoke.statusCode).toBe(401);
  });
});
