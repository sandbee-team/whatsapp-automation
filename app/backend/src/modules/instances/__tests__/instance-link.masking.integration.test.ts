import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../../platform/redis.js';
import {
  buildInstancesApp,
  buildTestConfig,
  cleanupInstancesRecords,
  onboardedMfaClient,
  seedPlanForClient,
} from './instances-routes-test-support.js';

/**
 * instance-link.masking.integration.test.ts (P08 Unit U6c) - proves the full
 * E.164 phone number never leaves the API through any of the six instance
 * link/park routes' response bodies - only the masked shape
 * `^\+\d{1,3}·····\d{2}$` ever appears. Split from
 * instance-link.routes.integration.test.ts for max-lines.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
const sentVerificationUrls = new Map<string, string>();

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];
const createdPlanIds: string[] = [];

const SEEDED_E164 = '+919876543221';
const MASKED_PATTERN = /^\+\d{1,3}·····\d{2}$/u;

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
  const config = buildTestConfig();
  app = await buildInstancesApp({ pool, tenantDb, redis, config, sentVerificationUrls });
});

afterAll(async () => {
  await app.close();
  await cleanupInstancesRecords(pool, redis, createdUserIds, createdClientIds, createdPlanIds);
  redis.disconnect();
  await pool.end();
});

describe('full phone number never leaves the API', () => {
  it('full_number_never_in_any_response', async () => {
    const { client, mfaAccessToken } = await onboardedMfaClient(
      app,
      sentVerificationUrls,
      'masking',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);
    const planId = await seedPlanForClient(pool, client.clientId, {
      maxRegisteredInstances: 5,
      maxConnectedInstances: 5,
    });
    createdPlanIds.push(planId);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { label: 'masked-number-probe' },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().data as { id: string };

    // Seed a linked-connected phone number directly (no HTTP route for the
    // engine's own markLinkedConnected write - that is the runner's job).
    await pool.query('UPDATE whatsapp_instances SET phone_e164 = $1 WHERE id = $2', [
      SEEDED_E164,
      created.id,
    ]);

    const onlineResponse = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/online`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(onlineResponse.statusCode).toBe(200);

    const statusResponse = await app.inject({
      method: 'GET',
      url: `/v1/instances/${created.id}/link-status`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(statusResponse.statusCode).toBe(200);
    const statusBody = statusResponse.json().data as { maskedNumber: string | null };
    expect(statusBody.maskedNumber).toMatch(MASKED_PATTERN);

    const parkResponse = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/park`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(parkResponse.statusCode).toBe(200);

    const responses = [createResponse, onlineResponse, statusResponse, parkResponse];
    for (const response of responses) {
      expect(response.body).not.toContain(SEEDED_E164);
      // Strip the leading '+' shared by both the raw and masked forms before
      // checking for the raw national-number digit run, so the masked
      // shape's own digits never false-positive this check.
      expect(response.body).not.toContain(SEEDED_E164.slice(1));
    }
  });
});
