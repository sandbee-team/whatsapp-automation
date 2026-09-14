import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signImpersonationToken } from '../identity/impersonation-token.js';
import { startU3cHarness, type U3cHarness } from './__tests__/internal-u3c-app-fixture.js';
import { internalTokenHeader } from './__tests__/internal-routes-test-support.js';
import { grantAndMint } from './__tests__/internal-u3c-support.js';

/**
 * internal-impersonation.integration.test.ts (P28 Unit U3c) - grant/mint/
 * expiry/revoke/replay. The elevate + route-layer write-block + redaction
 * cases live in the `internal-impersonation-writes.integration.test.ts`
 * sibling (300-line cap split - both share `__tests__/
 * internal-u3c-app-fixture.ts`). `.integration.test.ts` suffix is mandatory
 * (real Postgres + Redis - epoch-cache invalidation on revoke is asserted
 * directly).
 */

const SECRET = 'internal-u3c-impersonation-test-secret-01234';

let h: U3cHarness;

beforeAll(async () => {
  h = await startU3cHarness({
    secret: SECRET,
    applicationName: 'internal-u3c-impersonation-tests',
  });
});

afterAll(async () => {
  await h.close();
});

interface GrantBody {
  data: { grantId: string; clientId: string; scope: string; expiresAt: string };
}

describe('internal-impersonation', () => {
  it('an_impersonation_grant_expires_and_cannot_be_extended_silently', async () => {
    const { clientId } = await h.seedOwnerTenant();
    const staffId = await h.seedStaff('ops');

    await expect(
      h.pool.query(
        `INSERT INTO impersonation_grants (client_id, staff_id, reason, created_at, expires_at)
         VALUES ($1, $2, 'probe', now(), now() + interval '31 minutes')`,
        [clientId, staffId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const overLong = await h.sendInternal(
      'POST',
      `/internal/v1/clients/${clientId}/impersonation`,
      staffId,
      { reason: 'trying to exceed the cap', durationMinutes: 31 },
    );
    expect(overLong.statusCode).toBe(400);
    expect(overLong.json().error.code).toBe('VALIDATION_ERROR');

    const expiredId = (
      await h.pool.query<{ id: string }>(
        `INSERT INTO impersonation_grants
           (client_id, staff_id, target_user_id, reason, created_at, expires_at)
         SELECT $1, $2, user_id, 'expired probe', now() - interval '1 hour', now() - interval '30 minutes'
           FROM memberships WHERE client_id = $1 AND role = 'owner'
         RETURNING id`,
        [clientId, staffId],
      )
    ).rows[0]!.id;

    const mintExpired = await h.sendInternal(
      'POST',
      `/internal/v1/impersonation/${expiredId}/token`,
      staffId,
      { reason: 'attempt mint on expired grant' },
    );
    expect(mintExpired.statusCode).toBe(409);
    expect(mintExpired.json().error.code).toBe('INVALID_STATE');

    const oldToken = await signImpersonationToken(
      {
        jwtSecret: SECRET,
        targetUserId: staffId,
        grantId: expiredId,
        clientId,
        role: 'owner',
        epoch: 0,
        scope: 'metadata_only',
        staffId,
      },
      new Date(Date.now() - 10 * 60 * 1000),
    );
    const refreshRes = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/impersonation/refresh',
      headers: { authorization: `Bearer ${oldToken.accessToken}` },
    });
    expect(refreshRes.statusCode).toBe(401);

    const before = await h.pool.query<{ expires_at: string }>(
      'SELECT expires_at FROM impersonation_grants WHERE id = $1',
      [expiredId],
    );
    const revoke = await h.sendInternal(
      'POST',
      `/internal/v1/impersonation/${expiredId}/revoke`,
      staffId,
      { reason: 'cleanup' },
    );
    expect(revoke.statusCode).toBe(200);
    const after = await h.pool.query<{ expires_at: string }>(
      'SELECT expires_at FROM impersonation_grants WHERE id = $1',
      [expiredId],
    );
    expect(after.rows[0]?.expires_at).toStrictEqual(before.rows[0]?.expires_at);
  });

  it('revoking_a_grant_bumps_token_epoch_and_kills_the_session', async () => {
    const { clientId, ownerUserId } = await h.seedOwnerTenant();
    const staffId = await h.seedStaff('support');

    const epochBefore = await h.pool.query<{ token_epoch: string }>(
      'SELECT token_epoch FROM users WHERE id = $1',
      [ownerUserId],
    );

    const { grantId, accessToken } = await grantAndMint(h, staffId, clientId);

    const meRes = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().data.impersonation).toMatchObject({ grantId, scope: 'metadata_only' });

    const revoke = await h.sendInternal(
      'POST',
      `/internal/v1/impersonation/${grantId}/revoke`,
      staffId,
      { reason: 'investigation complete' },
    );
    expect(revoke.statusCode).toBe(200);

    const auditRows = await h.pool.query<{ action: string }>(
      `SELECT action FROM staff_audit_log WHERE client_id = $1 AND action = 'impersonation.revoke'`,
      [clientId],
    );
    expect(auditRows.rows).toHaveLength(1);

    const meAfterRevoke = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meAfterRevoke.statusCode).toBe(401);

    const epochAfter = await h.pool.query<{ token_epoch: string }>(
      'SELECT token_epoch FROM users WHERE id = $1',
      [ownerUserId],
    );
    expect(Number(epochAfter.rows[0]?.token_epoch)).toBe(
      Number(epochBefore.rows[0]?.token_epoch) + 1,
    );
  });

  it('a_replayed_mint_returns_one_audit_row_and_never_re_emits_the_token', async () => {
    const { clientId } = await h.seedOwnerTenant();
    const staffId = await h.seedStaff('support');

    const grant = await h.sendInternal(
      'POST',
      `/internal/v1/clients/${clientId}/impersonation`,
      staffId,
      { reason: 'replay probe' },
    );
    const grantId = (grant.json() as GrantBody).data.grantId;

    const idempotencyKey = `mint-replay-${grantId}`;
    const method = 'POST';
    const path = `/internal/v1/impersonation/${grantId}/token`;
    const headers = {
      'x-wp-internal-token': internalTokenHeader(SECRET, method, path),
      'x-actor': `staff:${staffId}`,
      'idempotency-key': idempotencyKey,
    };

    const first = await h.app.inject({ method, url: path, headers, payload: { reason: 'first' } });
    const second = await h.app.inject({ method, url: path, headers, payload: { reason: 'first' } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // The WINNING call carries the real bearer token; a REPLAY must never
    // re-emit it (C1 review round 2, MAJOR 2 linked MINOR) - `result` is
    // what got persisted to `staff_audit_log.result` on the first call, and
    // a live credential must never sit there.
    expect(typeof first.json().data.accessToken).toBe('string');
    expect(first.json().data.panelEntryPath).toContain('#token=');
    expect(first.json().data.replayed).toBe(false);
    expect(second.json().data.accessToken).toBeNull();
    expect(second.json().data.panelEntryPath).toBeNull();
    expect(second.json().data.replayed).toBe(true);
    expect(second.json().data.grantId).toBe(first.json().data.grantId);

    const auditCount = await h.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM staff_audit_log WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    expect(Number(auditCount.rows[0]?.n)).toBe(1);

    const storedResult = await h.pool.query<{ result: string }>(
      `SELECT result::text AS result FROM staff_audit_log WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    // The stored audit result must never contain the raw token or the
    // fragment that embeds it - only the redacted shape.
    expect(storedResult.rows[0]?.result ?? '').not.toContain('accessToken');
    expect(storedResult.rows[0]?.result ?? '').not.toContain('#token=');
  });
});
