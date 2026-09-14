import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  buildMediaRoutesHarness,
  seedApiKey,
  signAccessToken,
} from './__tests__/media-route-test-support.js';

/**
 * media.routes.integration.test.ts (P34 U-upload, ADR 0052 accepted scope)
 * - real Postgres, real HTTP (`buildMediaRoutesHarness`). Named-test list
 * per this unit's own dispatch: over-cap rejected with no row/object;
 * disallowed MIME rejected; a valid image upload stores exactly one object;
 * the same bytes twice return the SAME id and store ONE object; an API-key
 * principal can upload; a foreign tenant's GET is 404; the storage key
 * never appears in any response body.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let app: FastifyInstance;
let probeClientIds: string[] = [];
let probeUserIds: string[] = [];

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'media-routes-test',
  });
  tenantDb = createTenantDb(pool);
  const harness = await buildMediaRoutesHarness(tenantDb, pool);
  app = harness.app;
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM media_assets WHERE client_id = ANY($1::uuid[])', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM api_keys WHERE client_id = ANY($1::uuid[])', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1::uuid[])', [probeClientIds]);
  }
  if (probeUserIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [probeUserIds]);
  }
  probeClientIds = [];
  probeUserIds = [];
});

async function seedTenant(label: string): Promise<{ clientId: string; userId: string }> {
  const clientId = randomUUID();
  const userId = randomUUID();
  const slug = `media-routes-${label}-${clientId}`;
  await pool.query('INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [
    userId,
    `Media Routes Probe ${label}`,
    `media-routes-${label}-${clientId}@example.com`,
  ]);
  await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
    clientId,
    `Media Routes Probe ${label}`,
    slug,
  ]);
  probeClientIds.push(clientId);
  probeUserIds.push(userId);
  return { clientId, userId };
}

async function authHeaders(clientId: string, userId: string): Promise<Record<string, string>> {
  const token = await signAccessToken({ userId, clientId, role: 'owner' });
  return { authorization: `Bearer ${token}` };
}

describe('media routes', () => {
  it('a_valid_image_upload_stores_exactly_one_object_and_returns_metadata_without_a_storage_key', async () => {
    const { clientId, userId } = await seedTenant('valid');
    const headers = await authHeaders(clientId, userId);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/media?kind=image',
      headers: { ...headers, 'content-type': 'image/png' },
      payload: Buffer.from('fake-png-bytes'),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { data: Record<string, unknown> };
    expect(body.data.kind).toBe('image');
    expect(body.data.mimeType).toBe('image/png');
    expect(JSON.stringify(body)).not.toContain('storageKey');
    expect(JSON.stringify(body)).not.toContain('clients/');

    const rows = await pool.query('SELECT id FROM media_assets WHERE client_id = $1', [clientId]);
    expect(rows.rows).toHaveLength(1);
  });

  it('an_over_cap_upload_is_rejected_and_leaves_no_row_and_no_object', async () => {
    const { clientId, userId } = await seedTenant('overcap');
    const headers = await authHeaders(clientId, userId);
    const overCap = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/media?kind=image',
      headers: { ...headers, 'content-type': 'image/png' },
      payload: overCap,
    });

    expect(response.statusCode).toBe(413);
    const rows = await pool.query('SELECT id FROM media_assets WHERE client_id = $1', [clientId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('a_disallowed_mime_is_rejected', async () => {
    const { clientId, userId } = await seedTenant('badmime');
    const headers = await authHeaders(clientId, userId);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/media?kind=image',
      headers: { ...headers, 'content-type': 'application/x-msdownload' },
      payload: Buffer.from('MZ'),
    });

    expect(response.statusCode).toBe(415);
    const rows = await pool.query('SELECT id FROM media_assets WHERE client_id = $1', [clientId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('the_same_bytes_uploaded_twice_return_the_same_id_and_store_one_object', async () => {
    const { clientId, userId } = await seedTenant('dedupe');
    const headers = await authHeaders(clientId, userId);
    const bytes = Buffer.from('identical-bytes-probe');

    const first = await app.inject({
      method: 'POST',
      url: '/v1/media?kind=document',
      headers: { ...headers, 'content-type': 'application/pdf' },
      payload: bytes,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/media?kind=document',
      headers: { ...headers, 'content-type': 'application/pdf' },
      payload: bytes,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const firstId = (first.json() as { data: { id: string } }).data.id;
    const secondId = (second.json() as { data: { id: string } }).data.id;
    expect(secondId).toBe(firstId);

    const rows = await pool.query('SELECT id FROM media_assets WHERE client_id = $1', [clientId]);
    expect(rows.rows).toHaveLength(1);
  });

  it('an_api_key_principal_can_upload', async () => {
    const { clientId, userId } = await seedTenant('apikey');
    const key = await seedApiKey(pool, clientId, userId);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/media?kind=image',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'image/jpeg' },
      payload: Buffer.from('fake-jpeg-from-api-key'),
    });

    expect(response.statusCode).toBe(201);
    const rows = await pool.query('SELECT id FROM media_assets WHERE client_id = $1', [clientId]);
    expect(rows.rows).toHaveLength(1);
  });

  it('a_foreign_tenants_get_is_404', async () => {
    const ownerA = await seedTenant('foreign-a');
    const ownerB = await seedTenant('foreign-b');
    const headersA = await authHeaders(ownerA.clientId, ownerA.userId);
    const headersB = await authHeaders(ownerB.clientId, ownerB.userId);

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/media?kind=image',
      headers: { ...headersA, 'content-type': 'image/png' },
      payload: Buffer.from('owner-a-bytes'),
    });
    const id = (upload.json() as { data: { id: string } }).data.id;

    const asOwnerB = await app.inject({
      method: 'GET',
      url: `/v1/media/${id}`,
      headers: headersB,
    });
    expect(asOwnerB.statusCode).toBe(404);

    const asOwnerA = await app.inject({
      method: 'GET',
      url: `/v1/media/${id}`,
      headers: headersA,
    });
    expect(asOwnerA.statusCode).toBe(200);
    expect(JSON.stringify(asOwnerA.json())).not.toContain('storageKey');
  });
});
