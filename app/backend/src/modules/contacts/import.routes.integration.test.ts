import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { MAX_UPLOAD_BYTES } from './import-upload.js';
import {
  buildContactsApp,
  buildTestConfig,
  makePepperProvider,
  onboardedClient,
} from './__tests__/contacts-routes-test-support.js';
import {
  attachPlan,
  cleanupContactsRoutesRecords,
} from './__tests__/contacts-routes-cleanup-support.js';
import { buildTestObjectStore, generateCsv } from './__tests__/import-test-support.js';

/**
 * import.routes.integration.test.ts (P20 Unit U6, step 5) - the CSV import
 * upload/create/attestation-gate HTTP surface against real Postgres + a
 * real (fs) object store. The full poll/cancel/errors-csv lifecycle case is
 * split into the sibling `import-routes-lifecycle.integration.test.ts`
 * purely for this file's own 300-line cap (same "independent beforeAll/
 * afterAll per split file" idiom as
 * `modules/wallet/wallet-edge-cases-p19*.integration.test.ts`).
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
    applicationName: 'contacts-import-routes-it',
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

async function readyClient(label: string): Promise<{ accessToken: string; clientId: string }> {
  const { client, accessToken } = await onboardedClient(app, sentVerificationUrls, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  return { accessToken, clientId: client.clientId };
}

async function seedPlan(clientId: string, maxContacts: number): Promise<void> {
  const planId = await attachPlan(pool, clientId, { maxContacts });
  createdPlanIds.push(planId);
}

async function uploadCsv(
  accessToken: string,
  body: string | Buffer,
): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> {
  return app.inject({
    method: 'POST',
    url: '/v1/contacts/imports/uploads',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'text/csv' },
    payload: body,
  });
}

describe('upload_requires_text_csv_and_enforces_the_16mb_cap', () => {
  it('upload_requires_text_csv_and_enforces_the_16mb_cap', async () => {
    const { accessToken, clientId } = await readyClient('upload-caps');
    await seedPlan(clientId, 100);

    const jsonRes = await app.inject({
      method: 'POST',
      url: '/v1/contacts/imports/uploads',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      payload: { not: 'csv' },
    });
    expect(jsonRes.statusCode).toBe(415);

    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x61);
    const tooBigRes = await uploadCsv(accessToken, oversized);
    expect(tooBigRes.statusCode).toBe(413);
    const listed: string[] = [];
    for await (const obj of objectStore.list(`clients/${clientId}/imports/`)) {
      listed.push(obj.key);
    }
    expect(listed.length).toBe(0);

    const csv = generateCsv(12);
    const okRes = await uploadCsv(accessToken, csv);
    expect(okRes.statusCode).toBe(201);
    const body = okRes.json().data;
    expect(body.columns).toEqual(['phone', 'name', 'city']);
    expect(body.preview.length).toBe(10);
    expect(body.delimiter).toBe(',');
    expect(body.defaultCountry).toBe('IN');
    expect(body.bytes).toBe(Buffer.byteLength(csv));
  });
});

describe('an_import_cannot_be_created_without_the_attestation', () => {
  it('an_import_cannot_be_created_without_the_attestation', async () => {
    const { accessToken, clientId } = await readyClient('no-attest');
    await seedPlan(clientId, 100);
    const { clientId: otherClientId } = await readyClient('no-attest-other');
    await seedPlan(otherClientId, 100);

    const csv = generateCsv(3);
    const uploadRes = await uploadCsv(accessToken, csv);
    const storageKey = uploadRes.json().data.storageKey as string;

    const missing = await app.inject({
      method: 'POST',
      url: '/v1/contacts/imports',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        storageKey,
        mapping: { phone: 'phone', name: 'name' },
        attestationAccepted: true,
      },
    });
    expect(missing.statusCode).toBe(400);

    const blank = await app.inject({
      method: 'POST',
      url: '/v1/contacts/imports',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        storageKey,
        mapping: { phone: 'phone', name: 'name' },
        attestationText: '  ',
        attestationAccepted: true,
      },
    });
    expect(blank.statusCode).toBe(400);

    const notAccepted = await app.inject({
      method: 'POST',
      url: '/v1/contacts/imports',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        storageKey,
        mapping: { phone: 'phone', name: 'name' },
        attestationText: 'Collected via signup forms.',
        attestationAccepted: false,
      },
    });
    expect(notAccepted.statusCode).toBe(400);

    const foreignKey = storageKey.replace(clientId, otherClientId);
    const foreign = await app.inject({
      method: 'POST',
      url: '/v1/contacts/imports',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        storageKey: foreignKey,
        mapping: { phone: 'phone', name: 'name' },
        attestationText: 'Collected via signup forms.',
        attestationAccepted: true,
      },
    });
    expect(foreign.statusCode).toBe(404);

    const wellFormedMissing = await app.inject({
      method: 'POST',
      url: '/v1/contacts/imports',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        storageKey: `clients/${clientId}/imports/2026/01/${randomUUID()}.csv`,
        mapping: { phone: 'phone', name: 'name' },
        attestationText: 'Collected via signup forms.',
        attestationAccepted: true,
      },
    });
    expect(wellFormedMissing.statusCode).toBe(404);

    const importsCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_imports WHERE client_id = $1',
      [clientId],
    );
    expect(Number(importsCount.rows[0]?.count)).toBe(0);
    const consentCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM consent_records WHERE client_id = $1',
      [clientId],
    );
    expect(Number(consentCount.rows[0]?.count)).toBe(0);
  });
});

// `the_import_lifecycle_is_pollable_and_cancellable` lives in the sibling
// `import-routes-lifecycle.integration.test.ts` (300-line cap split, see
// this file's own header).
