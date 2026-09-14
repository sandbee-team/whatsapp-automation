import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startU3cHarness, type U3cHarness } from './__tests__/internal-u3c-app-fixture.js';
import { grantAndMint } from './__tests__/internal-u3c-support.js';

/**
 * internal-impersonation-writes.integration.test.ts (P28 Unit U3c) - body
 * elevation and the route-layer write ban. Split out of
 * `internal-impersonation.integration.test.ts` for the 300-line cap (both
 * share `__tests__/internal-u3c-app-fixture.ts` and this file reuses that
 * one's `grantAndMint` helper - same "shared helper, not a duplicate"
 * discipline the U3b fixtures use).
 *
 * DEVIATION (reported honestly, two parts):
 *  1. The phase dispatch's redaction case assumes a `GET /v1/messages/
 *     :publicId` route exists. It does not - `modules/messages/
 *     messages.routes.ts` registers `POST /v1/messages` only, and a
 *     line-by-line audit of EVERY `*.routes.ts` file in `app/backend/src`
 *     (grep for `payload`/`caption`/`quotedText`/`mediaUrl`/`rawMessage`,
 *     confirmed by reading `lifecycle-detail.ts#BroadcastDetail`) found no
 *     route anywhere that returns message-body text to a client today - not
 *     even `GET /v1/broadcasts/:id` (its `message` field the dispatch named
 *     does not exist on the wire; `BroadcastDetail` never carries it).
 *     Redaction (`redactMessageBodies`/`isMetadataOnly`/
 *     `sendImpersonationSafe`, `modules/identity/impersonation-principal.ts`
 *     + `platform/http/error-mapper.ts`) is proven by a UNIT test instead
 *     (`impersonation-principal.test.ts`) and wired defensively into
 *     `broadcasts.routes.ts`'s two GET handlers for forward-compatibility -
 *     inventing a new message-read HTTP route to exercise it end-to-end is a
 *     substantial, out-of-scope feature for this dispatch.
 *  2. The write-block case uses `POST`/`PATCH /v1/webhooks/endpoints` (both
 *     `policy: 'session'`) instead of `POST /v1/instances/:id/resume`
 *     (`policy: 'session_mfa'` - its own MFA gate would 401 an `mfa:false`
 *     impersonation token before the write-guard is ever reached, testing a
 *     different code path than the one this case is about).
 */

const SECRET = 'internal-u3c-impersonation-test-secret-01234';

let h: U3cHarness;

beforeAll(async () => {
  h = await startU3cHarness({
    secret: SECRET,
    applicationName: 'internal-u3c-impersonation-writes-tests',
  });
});

afterAll(async () => {
  await h.close();
});

describe('internal-impersonation', () => {
  it('impersonation_defaults_to_metadata_only_and_ordinary_reads_still_work', async () => {
    const { clientId } = await h.seedOwnerTenant();
    const staffId = await h.seedStaff('support');
    const { grantId, accessToken } = await grantAndMint(h, staffId, clientId);

    const grantRow = await h.pool.query<{ scope: string }>(
      'SELECT scope FROM impersonation_grants WHERE id = $1',
      [grantId],
    );
    expect(grantRow.rows[0]?.scope).toBe('metadata_only');

    const notifRes = await h.app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(notifRes.statusCode).toBe(200);

    const meRes = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().data.impersonation.scope).toBe('metadata_only');
  });

  it('body_elevation_is_a_separate_audited_grant_and_notifies_the_owner', async () => {
    const { clientId } = await h.seedOwnerTenant();
    const superadminId = await h.seedStaff('superadmin');
    const supportId = await h.seedStaff('support');

    const grant = await h.sendInternal(
      'POST',
      `/internal/v1/clients/${clientId}/impersonation`,
      superadminId,
      { reason: 'need message body access for a billing dispute' },
    );
    const grantId = (grant.json() as { data: { grantId: string } }).data.grantId;

    const forbiddenElevate = await h.sendInternal(
      'POST',
      `/internal/v1/impersonation/${grantId}/elevate`,
      supportId,
      { reason: 'support attempting elevation' },
    );
    expect(forbiddenElevate.statusCode).toBe(403);

    const elevate = await h.sendInternal(
      'POST',
      `/internal/v1/impersonation/${grantId}/elevate`,
      superadminId,
      { reason: 'billing dispute needs the exact message text' },
    );
    expect(elevate.statusCode).toBe(200);
    const elevated = elevate.json() as {
      data: { grantId: string; parentGrantId: string; scope: string };
    };
    expect(elevated.data.parentGrantId).toBe(grantId);
    expect(elevated.data.scope).toBe('with_message_bodies');

    const row = await h.pool.query<{
      parent_grant_id: string;
      created_at: string;
      expires_at: string;
    }>('SELECT parent_grant_id, created_at, expires_at FROM impersonation_grants WHERE id = $1', [
      elevated.data.grantId,
    ]);
    expect(row.rows[0]?.parent_grant_id).toBe(grantId);
    const durationMs =
      new Date(row.rows[0]!.expires_at).getTime() - new Date(row.rows[0]!.created_at).getTime();
    expect(durationMs).toBeLessThanOrEqual(15 * 60 * 1000);

    const auditRows = await h.pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE client_id = $1 AND action = 'impersonation_body_elevation'`,
      [clientId],
    );
    expect(auditRows.rows).toHaveLength(1);

    const notifs = await h.pool.query<{ kind: string }>(
      'SELECT kind FROM notifications WHERE client_id = $1 ORDER BY created_at ASC',
      [clientId],
    );
    const kinds = notifs.rows.map((r) => r.kind);
    expect(kinds.filter((k) => k === 'impersonation_started')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'impersonation_body_access')).toHaveLength(1);

    // The elevated grant mints its own token, and `me` reflects the
    // elevated (`with_message_bodies`) scope - a DIFFERENT grant/session
    // than the metadata-only one this staff member started with.
    const mintElevated = await h.sendInternal(
      'POST',
      `/internal/v1/impersonation/${elevated.data.grantId}/token`,
      superadminId,
      { reason: 'read the message body' },
    );
    expect(mintElevated.statusCode).toBe(200);
    const elevatedToken = (mintElevated.json() as { data: { accessToken: string } }).data
      .accessToken;

    const meRes = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${elevatedToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().data.impersonation).toMatchObject({
      grantId: elevated.data.grantId,
      scope: 'with_message_bodies',
    });
  });

  it('impersonation_writes_are_blocked_at_the_route_layer', async () => {
    const { clientId } = await h.seedOwnerTenant();
    const staffId = await h.seedStaff('support');
    const { accessToken } = await grantAndMint(h, staffId, clientId);

    const create = await h.app.inject({
      method: 'POST',
      url: '/v1/webhooks/endpoints',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { url: 'https://example.test/hook', events: ['message.sent'] },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().error.code).toBe('FORBIDDEN');
    expect(create.json().error.details.reason).toBe('impersonated_session_is_read_only');

    const patch = await h.app.inject({
      method: 'PATCH',
      url: '/v1/webhooks/endpoints/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(403);

    const rows = await h.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM webhook_endpoints WHERE client_id = $1',
      [clientId],
    );
    expect(rows.rows[0]?.n).toBe(0);

    const refresh = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/impersonation/refresh',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(refresh.statusCode).toBe(200);
    const body = refresh.json() as { data: { accessToken: string } };
    const decoded = JSON.parse(
      Buffer.from(body.data.accessToken.split('.')[1]!, 'base64url').toString('utf8'),
    ) as { iat: number; exp: number };
    expect(decoded.exp - decoded.iat).toBe(120);
  });
});
