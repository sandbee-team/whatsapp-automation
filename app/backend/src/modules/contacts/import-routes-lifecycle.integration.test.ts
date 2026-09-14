import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { runOneContactImportSweep } from './import-runner.js';
import {
  buildContactsApp,
  buildTestConfig,
  makePepperProvider,
  onboardedClient,
  STRONG_PASSWORD,
} from './__tests__/contacts-routes-test-support.js';
import {
  attachPlan,
  cleanupContactsRoutesRecords,
} from './__tests__/contacts-routes-cleanup-support.js';
import { buildTestObjectStore, generateCsv, noOpMetrics } from './__tests__/import-test-support.js';

/**
 * import-routes-lifecycle.integration.test.ts (P20 Unit U6, step 5) - the
 * full poll/cancel/errors-csv lifecycle half of `import.routes.integration.
 * test.ts`, split out purely for that file's own 300-line cap (same
 * "independent beforeAll/afterAll per split file" idiom as
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
    applicationName: 'contacts-import-lifecycle-it',
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

async function readyClient(
  label: string,
): Promise<{ accessToken: string; clientId: string; email: string }> {
  const { client, accessToken } = await onboardedClient(app, sentVerificationUrls, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  return { accessToken, clientId: client.clientId, email: client.email };
}

async function seedPlan(clientId: string, maxContacts: number): Promise<void> {
  const planId = await attachPlan(pool, clientId, { maxContacts });
  createdPlanIds.push(planId);
}

async function uploadCsv(
  accessToken: string,
  body: string,
): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> {
  return app.inject({
    method: 'POST',
    url: '/v1/contacts/imports/uploads',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'text/csv' },
    payload: body,
  });
}

async function createImport(
  accessToken: string,
  storageKey: string,
  attestationText = 'Collected via in-store signup forms.',
): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> {
  return app.inject({
    method: 'POST',
    url: '/v1/contacts/imports',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      storageKey,
      mapping: { phone: 'phone', name: 'name' },
      attestationText,
      attestationAccepted: true,
    },
  });
}

describe('the_import_lifecycle_is_pollable_and_cancellable', () => {
  it('the_import_lifecycle_is_pollable_and_cancellable', async () => {
    const { accessToken, clientId, email } = await readyClient('lifecycle');
    await seedPlan(clientId, 100);
    const { accessToken: otherToken } = await readyClient('lifecycle-other');

    const csv =
      'phone,name,city\n' +
      '+919800000001,Alice,City0\n' +
      '+919800000002,Bob,City1\n' +
      'not-a-phone,Carl,City2\n' +
      'also-not-a-phone,Dana,City3\n' +
      '+919800000003,Eve,City4\n';
    const uploadRes = await uploadCsv(accessToken, csv);
    const storageKey = uploadRes.json().data.storageKey as string;

    const createRes = await createImport(accessToken, storageKey);
    expect(createRes.statusCode).toBe(201);
    const importId = createRes.json().data.id as string;
    expect(createRes.json().data.status).toBe('uploaded');
    expect(createRes.json().data.attestedByUserId).toBeTruthy();

    const pollBefore = await app.inject({
      method: 'GET',
      url: `/v1/contacts/imports/${importId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(pollBefore.json().data.status).toBe('uploaded');

    for (let i = 0; i < 10; i += 1) {
      const result = await runOneContactImportSweep({
        pool,
        tenantDb,
        keyProvider: pepperProvider,
        objectStore,
        metrics: noOpMetrics(),
        maxClientsPerSweep: 50,
      });
      if (result.importsTouched === 0) break;
    }

    const pollAfter = await app.inject({
      method: 'GET',
      url: `/v1/contacts/imports/${importId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(pollAfter.json().data.status).toBe('done');
    expect(pollAfter.json().data.importedCount).toBe(3);
    expect(pollAfter.json().data.invalidCount).toBe(2);
    expect(pollAfter.json().data.totalRows).toBe(5);

    const errorsRes = await app.inject({
      method: 'GET',
      url: `/v1/contacts/imports/${importId}/errors.csv`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(errorsRes.statusCode).toBe(200);
    expect(errorsRes.headers['content-type']).toContain('text/csv');
    const errorLines = errorsRes.body.trim().split('\n');
    expect(errorLines[0]).toBe('row_no,reason,raw_excerpt');
    expect(errorLines.length).toBe(3);

    const secondUploadRes = await uploadCsv(accessToken, generateCsv(2));
    const secondKey = secondUploadRes.json().data.storageKey as string;
    const secondCreate = await createImport(accessToken, secondKey);
    const secondImportId = secondCreate.json().data.id as string;

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/v1/contacts/imports/${secondImportId}/cancel`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().data.status).toBe('cancelled');

    const cancelAgain = await app.inject({
      method: 'POST',
      url: `/v1/contacts/imports/${secondImportId}/cancel`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(cancelAgain.statusCode).toBe(409);

    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/contacts/imports',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const items = listRes.json().data.items as { id: string }[];
    expect(items.map((i) => i.id)).toEqual([secondImportId, importId]);

    const otherGet = await app.inject({
      method: 'GET',
      url: `/v1/contacts/imports/${importId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(otherGet.statusCode).toBe(404);

    await pool.query(`UPDATE memberships SET role = 'viewer' WHERE client_id = $1`, [clientId]);
    const viewerLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': '10.9.9.9' },
      payload: { email, password: STRONG_PASSWORD },
    });
    const viewerToken = viewerLogin.json().data.accessToken as string;
    const viewerCreate = await createImport(viewerToken, storageKey, 'x');
    expect(viewerCreate.statusCode).toBe(403);
  });
});
