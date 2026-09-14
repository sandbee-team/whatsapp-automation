import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import {
  buildContactsApp,
  buildTestConfig,
  makePepperProvider,
  onboardedClient,
  onboardedMfaClient,
} from './__tests__/contacts-routes-test-support.js';
import { cleanupContactsRoutesRecords } from './__tests__/contacts-routes-cleanup-support.js';
import { buildTestObjectStore } from './__tests__/import-test-support.js';

/**
 * contacts-routes-uuid-validation.integration.test.ts (P20 C1 m1) - a
 * malformed `:id` path param must map to 400 VALIDATION_ERROR, never reach
 * `::uuid` and surface as a 500 INTERNAL, across every router in the
 * module.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
const sentVerificationUrls = new Map<string, string>();
const pepperProvider = makePepperProvider();
const objectStore = buildTestObjectStore();
const createdUserIds: string[] = [];
const createdClientIds: string[] = [];
const createdPlanIds: string[] = [];

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'contacts-uuid-validation-it',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
  const config = buildTestConfig();
  app = await buildContactsApp({
    pool,
    tenantDb,
    redis,
    config,
    sentVerificationUrls,
    keyProvider: pepperProvider,
    objectStore,
  });
});

afterAll(async () => {
  await app.close();
  await cleanupContactsRoutesRecords(pool, redis, createdUserIds, createdClientIds, createdPlanIds);
  redis.disconnect();
  await pool.end();
});

describe('a malformed :id never reaches ::uuid as a 500', () => {
  it('get_contacts_id_with_a_malformed_id_is_400', async () => {
    const { client, accessToken } = await onboardedClient(app, sentVerificationUrls, 'uuid-get');
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/contacts/not-a-uuid',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('get_contacts_imports_id_with_a_malformed_id_is_400', async () => {
    const { client, accessToken } = await onboardedClient(
      app,
      sentVerificationUrls,
      'uuid-imports-get',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/contacts/imports/not-a-uuid',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('get_contacts_imports_id_errors_csv_with_a_malformed_id_is_400', async () => {
    const { client, accessToken } = await onboardedClient(
      app,
      sentVerificationUrls,
      'uuid-imports-errors-csv',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/contacts/imports/not-a-uuid/errors.csv',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('post_contacts_imports_id_cancel_with_a_malformed_id_is_400', async () => {
    const { client, accessToken } = await onboardedClient(
      app,
      sentVerificationUrls,
      'uuid-imports-cancel',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/imports/not-a-uuid/cancel',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('patch_contacts_id_with_a_malformed_id_is_400', async () => {
    const { client, accessToken } = await onboardedClient(app, sentVerificationUrls, 'uuid-patch');
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/contacts/not-a-uuid',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { displayName: 'X' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('post_contacts_id_tags_with_a_malformed_id_is_400', async () => {
    const { client, accessToken } = await onboardedClient(app, sentVerificationUrls, 'uuid-tags');
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/not-a-uuid/tags',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('patch_contacts_tags_id_with_a_malformed_id_is_400', async () => {
    const { client, accessToken } = await onboardedClient(
      app,
      sentVerificationUrls,
      'uuid-tags-patch',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/contacts/tags/not-a-uuid',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('delete_contacts_tags_id_with_a_malformed_id_is_400', async () => {
    const { client, accessToken } = await onboardedClient(
      app,
      sentVerificationUrls,
      'uuid-tags-delete',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/contacts/tags/not-a-uuid',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('delete_contacts_id_with_a_malformed_id_and_an_mfa_token_is_400', async () => {
    const { client, mfaAccessToken } = await onboardedMfaClient(
      app,
      sentVerificationUrls,
      'uuid-erase',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/contacts/not-a-uuid',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('a_cursor_whose_id_half_is_garbage_is_400', async () => {
    const { client, accessToken } = await onboardedClient(
      app,
      sentVerificationUrls,
      'uuid-cursor-contacts',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    // A well-formed base64url payload whose decoded shape is
    // `<validIsoDate>|not-a-uuid` - passes the date-parse half, fails the
    // UUID-shape half.
    const garbageCursor = Buffer.from('2026-01-01T00:00:00.000Z|not-a-uuid', 'utf8').toString(
      'base64url',
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/contacts?cursor=${garbageCursor}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('an_import_list_cursor_whose_id_half_is_garbage_is_400', async () => {
    const { client, accessToken } = await onboardedClient(
      app,
      sentVerificationUrls,
      'uuid-cursor-imports',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    const garbageCursor = Buffer.from('2026-01-01T00:00:00.000Z|not-a-uuid', 'utf8').toString(
      'base64url',
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/contacts/imports?cursor=${garbageCursor}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});
