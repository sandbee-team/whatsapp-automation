import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { SafeFetchError } from '../../platform/http/safe-fetch.js';
import { createTenantDbAsRole } from '../../platform/db/test-support/wp-app-role.js';
import {
  buildRoutesHarness,
  makeKeyProvider,
  signAccessToken,
  acceptingFetchStub,
  type FetchStub,
} from './__tests__/webhooks-test-support.js';

/**
 * routes.integration.test.ts (P15 U5, step 8) - DEVIATION from the phase
 * task's literal filename `routes.test.ts`: these assertions require real
 * Postgres RLS (the cross-tenant 404-not-403 case) and a real `TenantDb`
 * transaction, so per this repo's own binding mechanical convention ("a
 * real-infra test is named `*.integration.test.ts` instead", never
 * `*.test.ts`) this file is `.integration.test.ts`. Real HS256 JWTs, a real
 * `FileKeyProvider`, real Fastify routes - only the outbound `fetchFn` is a
 * test double (never dials a real network).
 */

const pool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'webhooks-routes-test',
});
const tenantDb = createTenantDb(pool);

let seededClientIds: string[] = [];
let seededUserIds: string[] = [];

beforeAll(async () => {
  await pool.query('SELECT 1');
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (seededClientIds.length > 0) {
    // BUG FIX (P15 C1 FIX, discovered while adding F3's own `/test`-route
    // test): the `/test` route (routes.ts) INSERTs an `outbox_events` row
    // (never marked `published_at` by the route itself - only the relay's
    // own `drainOnce` does that) plus its `webhook_deliveries` row. Before
    // this fix, neither was ever cleaned up here, so a lingering unpublished,
    // webhook-fanned `outbox_events` row leaked across test FILES and threw
    // off other suites' exact-count `drainOnce` assertions (e.g.
    // `relay-backpressure.integration.test.ts`'s
    // `publishedByFanout.webhook` count) whenever both ran in the same
    // process.
    await pool.query('DELETE FROM webhook_deliveries WHERE client_id = ANY($1)', [seededClientIds]);
    await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [seededClientIds]);
    await pool.query('DELETE FROM webhook_endpoints WHERE client_id = ANY($1)', [seededClientIds]);
    await pool.query('DELETE FROM memberships WHERE client_id = ANY($1)', [seededClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [seededClientIds]);
  }
  if (seededUserIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [seededUserIds]);
  }
  seededClientIds = [];
  seededUserIds = [];
});

async function seedClientWithOwner(): Promise<{ clientId: string; userId: string }> {
  const clientId = randomUUID();
  const userId = randomUUID();
  seededClientIds.push(clientId);
  seededUserIds.push(userId);
  await pool.query(`INSERT INTO users (id, email, full_name) VALUES ($1, $2, 'Test Owner')`, [
    userId,
    `${clientId}@webhooks-test.example`,
  ]);
  await pool.query(
    `INSERT INTO clients (id, company_name, slug, owner_user_id) VALUES ($1, $2, $3, $4)`,
    [clientId, `Webhooks Test ${clientId}`, `webhooks-test-${clientId}`, userId],
  );
  await pool.query(`INSERT INTO memberships (client_id, user_id, role) VALUES ($1, $2, 'owner')`, [
    clientId,
    userId,
  ]);
  return { clientId, userId };
}

describe('webhook endpoint routes', () => {
  it('the_secret_is_returned_once_and_never_again', async () => {
    const { app } = buildRoutesHarness(tenantDb, makeKeyProvider(), acceptingFetchStub);
    const { clientId, userId } = await seedClientWithOwner();
    const token = await signAccessToken({ userId, clientId, role: 'owner' });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/endpoints',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'https://example.com/hooks/wp', events: ['job.needs_user_action'] },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json() as { data: { id: string; secret: string } };
    expect(typeof created.data.secret).toBe('string');
    expect(created.data.secret.length).toBeGreaterThan(0);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/endpoints',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listResponse.statusCode).toBe(200);
    expect(JSON.stringify(listResponse.json())).not.toContain(created.data.secret);

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/v1/webhooks/endpoints/${created.data.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });
    expect(patchResponse.statusCode).toBe(200);
    expect(JSON.stringify(patchResponse.json())).not.toContain(created.data.secret);

    const stored = await pool.query<{ secret_enc: Buffer }>(
      'SELECT secret_enc FROM webhook_endpoints WHERE id = $1',
      [created.data.id],
    );
    const storedText = stored.rows[0]?.secret_enc.toString('utf8') ?? '';
    expect(storedText).not.toContain(created.data.secret);
  });

  it('a_principal_without_webhooks_manage_cannot_create_an_endpoint', async () => {
    const { app } = buildRoutesHarness(tenantDb, makeKeyProvider(), acceptingFetchStub);
    const { clientId, userId } = await seedClientWithOwner();
    // A non-owner/admin role (e.g. 'member') - RBAC denial, not scope alone.
    const token = await signAccessToken({ userId, clientId, role: 'member' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/endpoints',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'https://example.com/hooks/wp', events: ['job.needs_user_action'] },
    });
    expect(response.statusCode).toBe(403);

    const rows = await pool.query('SELECT id FROM webhook_endpoints WHERE client_id = $1', [
      clientId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('a_tenant_cannot_read_or_patch_another_tenants_endpoint', async () => {
    const { app } = buildRoutesHarness(tenantDb, makeKeyProvider(), acceptingFetchStub);
    const ownerA = await seedClientWithOwner();
    const ownerB = await seedClientWithOwner();
    const tokenA = await signAccessToken({
      userId: ownerA.userId,
      clientId: ownerA.clientId,
      role: 'owner',
    });
    const tokenB = await signAccessToken({
      userId: ownerB.userId,
      clientId: ownerB.clientId,
      role: 'owner',
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/endpoints',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { url: 'https://example.com/hooks/wp', events: ['job.needs_user_action'] },
    });
    expect(createResponse.statusCode).toBe(201);
    const endpointId = (createResponse.json() as { data: { id: string } }).data.id;

    const patchAsB = await app.inject({
      method: 'PATCH',
      url: `/v1/webhooks/endpoints/${endpointId}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { enabled: false },
    });
    expect(patchAsB.statusCode).toBe(404);

    const deleteAsB = await app.inject({
      method: 'DELETE',
      url: `/v1/webhooks/endpoints/${endpointId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(deleteAsB.statusCode).toBe(404);
  });

  it('an_endpoint_url_pointing_at_an_internal_address_is_rejected_at_configuration_time', async () => {
    const denyingFetch: FetchStub = async () => {
      throw new SafeFetchError('address_denied', 'resolved address is a private/internal range');
    };
    const { app } = buildRoutesHarness(tenantDb, makeKeyProvider(), denyingFetch);
    const { clientId, userId } = await seedClientWithOwner();
    const token = await signAccessToken({ userId, clientId, role: 'owner' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/endpoints',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'https://internal.example.com/hooks/wp', events: ['job.needs_user_action'] },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('WEBHOOK_URL_REJECTED');

    const rows = await pool.query('SELECT id FROM webhook_endpoints WHERE client_id = $1', [
      clientId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('the_test_route_inserts_a_pending_delivery_row_even_under_the_real_wp_app_role', async () => {
    // BUG FIX (P15 C1 FIX F3 / MAJ-1): every other test in this file uses
    // the plain `createTenantDb(pool)` bound to the dev/test pool's own
    // PRIVILEGED connecting role, which masks a missing grant entirely -
    // `POST /v1/webhooks/endpoints/:id/test` INSERTs into
    // `webhook_deliveries`, which `wp_app` only ever had SELECT on (migration
    // 0041) until migration 0043 added a column-scoped INSERT grant. This
    // test runs the SAME route handler under `wp_app` via `SET LOCAL ROLE`
    // (`createTenantDbAsRole`, the established `wrapAsRole` idiom - see
    // `db/tests/wp-reaper-role.test.ts`'s own role-scoped proof discipline),
    // so it would have failed with a real Postgres permission error before
    // migration 0043.
    const wpAppTenantDb = createTenantDbAsRole(pool, 'wp_app');
    const { app } = buildRoutesHarness(wpAppTenantDb, makeKeyProvider(), acceptingFetchStub);
    const { clientId, userId } = await seedClientWithOwner();
    const token = await signAccessToken({ userId, clientId, role: 'owner' });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/endpoints',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'https://example.com/hooks/wp', events: ['job.needs_user_action'] },
    });
    expect(createResponse.statusCode).toBe(201);
    const endpointId = (createResponse.json() as { data: { id: string } }).data.id;

    const testResponse = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/endpoints/${endpointId}/test`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(testResponse.statusCode).toBe(200);
    const testBody = testResponse.json() as { data: { deliveryId: string; status: string } };
    expect(testBody.data.status).toBe('pending');

    const deliveryRows = await pool.query<{ status: string; endpoint_id: string }>(
      'SELECT status, endpoint_id FROM webhook_deliveries WHERE id = $1',
      [testBody.data.deliveryId],
    );
    expect(deliveryRows.rows).toHaveLength(1);
    expect(deliveryRows.rows[0]?.status).toBe('pending');
    expect(deliveryRows.rows[0]?.endpoint_id).toBe(endpointId);
  });
});
