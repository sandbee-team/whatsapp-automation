import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../../platform/redis.js';
import {
  buildTenancyApp,
  buildTestConfig,
  cleanupTenancyRecords,
  loginViaHttp,
  mintMfaAccessTokenViaHttp,
  signupClientViaHttp,
  verifyClientEmailViaHttp,
} from './tenancy-routes-test-support.js';

/**
 * entitlement.integration.test.ts (P04b Unit UB1b, phase step 7) - proves
 * the server-side entitlement gate (`modules/tenancy/entitlement.service.ts`)
 * over real HTTP against the stub `POST /v1/instances` route: an
 * unverified-email client is denied EVEN with a valid MFA session (the
 * UI-bypass proof), and a fully-onboarded client reaches the honest 501
 * stub rather than a false success or a false denial.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
const sentVerificationUrls = new Map<string, string>();

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
  const config = buildTestConfig();
  app = await buildTenancyApp({ pool, tenantDb, redis, config, sentVerificationUrls });
});

afterAll(async () => {
  await app.close();
  await cleanupTenancyRecords(pool, redis, createdUserIds, createdClientIds);
  redis.disconnect();
  await pool.end();
});

describe('entitlement gate on POST /v1/instances', () => {
  it('unverified_client_cannot_reach_the_connect_endpoint', async () => {
    const client = await signupClientViaHttp(app, 'unverified');
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    // No verify-email call - email stays unverified. Even so, mint a REAL
    // valid mfa:true session (the UI-bypass proof: a caller who somehow
    // already holds a fully-verified-looking session must still be denied
    // by the SERVER-SIDE gate, not just a client-side onboarding-wall UI).
    const plainAccessToken = await loginViaHttp(app, client.email);
    const mfaAccessToken = await mintMfaAccessTokenViaHttp(app, client.email, plainAccessToken);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('a_fully_onboarded_mfa_client_reaches_past_the_gate_to_the_routes_own_validation_not_a_403', async () => {
    const client = await signupClientViaHttp(app, 'onboarded');
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    await verifyClientEmailViaHttp(app, sentVerificationUrls, client.email);

    const plainAccessToken = await loginViaHttp(app, client.email);
    const mfaAccessToken = await mintMfaAccessTokenViaHttp(app, client.email, plainAccessToken);

    // Walk onboarding to connect_whatsapp using the SAME mfa session.
    const tzResponse = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/timezone',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { timezone: 'Asia/Kolkata' },
    });
    expect(tzResponse.statusCode).toBe(200);

    const pacingResponse = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/pacing-profile',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { profileKey: 'standard' },
    });
    expect(pacingResponse.statusCode).toBe(200);

    const consentResponse = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/consent',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { accepted: true },
    });
    expect(consentResponse.statusCode).toBe(200);
    const consentBody = consentResponse.json() as { data: { step: string } };
    expect(consentBody.data.step).toBe('connect_whatsapp');

    // P08 Unit U6c replaced the 501 stub with the real POST /v1/instances
    // route: an empty payload now fails the route's OWN input validation
    // (400 VALIDATION_ERROR) rather than the honest "not built yet" 501 -
    // this test's own subject (the entitlement gate lets a fully-onboarded
    // caller PAST it, never a false 403) is unaffected either way.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
