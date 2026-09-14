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
 * onboarding-boundary-cases.integration.test.ts (C2 hardening pass, P04b) -
 * oversized/malformed onboarding inputs, split out of the sibling
 * onboarding-edge-cases.integration.test.ts (concurrency/idempotency edges)
 * for max-lines. Every case here must be rejected at validation BEFORE any
 * DB touch (fail-safe: no partial write from a rejected request).
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

async function onboardedMfaClient(
  label: string,
): Promise<{ userId: string; clientId: string; email: string; accessToken: string }> {
  const client = await signupClientViaHttp(app, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  await verifyClientEmailViaHttp(app, sentVerificationUrls, client.email);
  const plainAccessToken = await loginViaHttp(app, client.email);
  const accessToken = await mintMfaAccessTokenViaHttp(app, client.email, plainAccessToken);
  return { ...client, accessToken };
}

describe('onboarding step machine - boundary/malformed-input validation', () => {
  it('an_oversized_timezone_string_is_rejected_at_validation_before_any_db_touch', async () => {
    const client = await onboardedMfaClient('oversized-timezone');
    const hugeTimezone = 'Asia/Kolkata'.padEnd(10_000, 'x');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/timezone',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { timezone: hugeTimezone },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');

    // Step never touched by the rejected request.
    const row = await pool.query<{ onboarding_step: string }>(
      'SELECT onboarding_step FROM clients WHERE id = $1',
      [client.clientId],
    );
    expect(row.rows[0]!.onboarding_step).toBe('choose_timezone');
  });

  it('an_oversized_profile_key_over_64_chars_is_rejected_at_validation_before_any_db_touch', async () => {
    const client = await onboardedMfaClient('oversized-profile-key');
    await app.inject({
      method: 'POST',
      url: '/v1/onboarding/timezone',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { timezone: 'Asia/Kolkata' },
    });

    const oversizedKey = 'a'.repeat(65);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/pacing-profile',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { profileKey: oversizedKey },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');

    const row = await pool.query<{ onboarding_step: string; pacing_profile_key: string | null }>(
      'SELECT onboarding_step, pacing_profile_key FROM clients WHERE id = $1',
      [client.clientId],
    );
    expect(row.rows[0]!.onboarding_step).toBe('accept_pacing_profile');
    expect(row.rows[0]!.pacing_profile_key).toBeNull();
  });

  it('a_profile_key_with_control_characters_is_rejected_at_validation_before_any_db_touch', async () => {
    const client = await onboardedMfaClient('control-char-profile-key');
    await app.inject({
      method: 'POST',
      url: '/v1/onboarding/timezone',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { timezone: 'Asia/Kolkata' },
    });

    // A raw NUL byte survives JSON but is a control char with no legitimate
    // place in a free-text profile key identifier - the CONTRACT enforces
    // `z.string().trim().min(1).max(64)`, which does NOT reject control
    // characters by itself. Expectation per the C2 task: rejected at
    // validation, never reaching the DB. Built via fromCharCode (never a
    // literal control byte in this source file).
    const controlCharKey = 'standard' + String.fromCharCode(0) + 'profile';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/pacing-profile',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { profileKey: controlCharKey },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');

    const row = await pool.query<{ pacing_profile_key: string | null }>(
      'SELECT pacing_profile_key FROM clients WHERE id = $1',
      [client.clientId],
    );
    expect(row.rows[0]!.pacing_profile_key).toBeNull();
  });

  it('an_empty_string_timezone_is_rejected_at_validation', async () => {
    const client = await onboardedMfaClient('empty-timezone');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/timezone',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { timezone: '' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
