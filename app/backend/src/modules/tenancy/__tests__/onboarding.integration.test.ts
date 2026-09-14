import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { TOS_VERSION } from '@wp/domain';
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
 * onboarding.integration.test.ts (P04b Unit UB1b, phase step 8) - the
 * onboarding step machine over real HTTP: monotonic ordered advancement
 * only, Connect-WhatsApp unreachable until every prerequisite step is
 * recorded, and the consent-attestation audit row.
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

async function postInstances(
  accessToken: string,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  return app.inject({
    method: 'POST',
    url: '/v1/instances',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
}

describe('onboarding step machine', () => {
  it('onboarding_steps_advance_only_in_order_and_never_backwards', async () => {
    const client = await onboardedMfaClient('order');

    // Out-of-order: attempt consent before timezone/pacing-profile are set.
    const outOfOrder = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/consent',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { accepted: true },
    });
    expect(outOfOrder.statusCode).toBe(409);
    const outOfOrderBody = outOfOrder.json() as {
      error: { code: string; details?: { currentStep?: string } };
    };
    expect(outOfOrderBody.error.code).toBe('CONFLICT');
    expect(outOfOrderBody.error.details?.currentStep).toBe('choose_timezone');

    // Advance in the correct order - each response's step is monotonic.
    const tz = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/timezone',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { timezone: 'Asia/Kolkata' },
    });
    expect(tz.statusCode).toBe(200);
    expect((tz.json() as { data: { step: string } }).data.step).toBe('accept_pacing_profile');

    // Replaying the SAME timezone step again must be rejected, never re-applied.
    const tzReplay = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/timezone',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { timezone: 'Asia/Kolkata' },
    });
    expect(tzReplay.statusCode).toBe(409);
    const tzReplayBody = tzReplay.json() as { error: { details?: { currentStep?: string } } };
    expect(tzReplayBody.error.details?.currentStep).toBe('accept_pacing_profile');

    const pacing = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/pacing-profile',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { profileKey: 'standard' },
    });
    expect(pacing.statusCode).toBe(200);
    expect((pacing.json() as { data: { step: string } }).data.step).toBe('attest_consent');

    const consent = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/consent',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { accepted: true },
    });
    expect(consent.statusCode).toBe(200);
    expect((consent.json() as { data: { step: string } }).data.step).toBe('connect_whatsapp');
  });

  it('connect_whatsapp_is_unreachable_until_timezone_profile_and_attestation_are_recorded', async () => {
    const client = await onboardedMfaClient('gate');

    const step1 = await postInstances(client.accessToken);
    expect(step1.statusCode).toBe(403);
    expect(
      (step1.json() as { error: { details?: { reason?: string } } }).error.details?.reason,
    ).toBe('onboarding_incomplete:choose_timezone');

    await app.inject({
      method: 'POST',
      url: '/v1/onboarding/timezone',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { timezone: 'Asia/Kolkata' },
    });

    const step2 = await postInstances(client.accessToken);
    expect(step2.statusCode).toBe(403);
    expect(
      (step2.json() as { error: { details?: { reason?: string } } }).error.details?.reason,
    ).toBe('onboarding_incomplete:accept_pacing_profile');

    await app.inject({
      method: 'POST',
      url: '/v1/onboarding/pacing-profile',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { profileKey: 'standard' },
    });

    const step3 = await postInstances(client.accessToken);
    expect(step3.statusCode).toBe(403);
    expect(
      (step3.json() as { error: { details?: { reason?: string } } }).error.details?.reason,
    ).toBe('onboarding_incomplete:attest_consent');

    await app.inject({
      method: 'POST',
      url: '/v1/onboarding/consent',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { accepted: true },
    });

    // P08 Unit U6c replaced the 501 stub with the real POST /v1/instances
    // route: a fully-onboarded caller now reaches past the entitlement gate
    // to the route's OWN input validation (empty payload -> 400
    // VALIDATION_ERROR, no longer NOT_IMPLEMENTED) - the entitlement-gate
    // assertion above (steps 1-3) is this test's own subject and is
    // unaffected.
    const step4 = await postInstances(client.accessToken);
    expect(step4.statusCode).toBe(400);
    expect((step4.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('consent_attestation_writes_an_audit_row_naming_the_user', async () => {
    const client = await onboardedMfaClient('audit');

    await app.inject({
      method: 'POST',
      url: '/v1/onboarding/timezone',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { timezone: 'Asia/Kolkata' },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/onboarding/pacing-profile',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { profileKey: 'standard' },
    });
    const before = new Date();
    const consent = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/consent',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { accepted: true },
    });
    expect(consent.statusCode).toBe(200);

    const auditRows = await pool.query<{ actor_user_id: string | null; action: string }>(
      `SELECT actor_user_id, action FROM audit_logs
        WHERE client_id = $1 AND action = 'onboarding.consent_attested'`,
      [client.clientId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0]!.actor_user_id).toBe(client.userId);

    const clientRow = await pool.query<{ consent_attested_at: Date | null }>(
      `SELECT consent_attested_at FROM clients WHERE id = $1`,
      [client.clientId],
    );
    expect(clientRow.rows[0]!.consent_attested_at).not.toBeNull();
    expect(clientRow.rows[0]!.consent_attested_at!.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 5000,
    );
  });

  it('set_consent_records_the_current_tos_version_on_the_client_and_the_audit_row', async () => {
    const client = await onboardedMfaClient('tos-version');

    await app.inject({
      method: 'POST',
      url: '/v1/onboarding/timezone',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { timezone: 'Asia/Kolkata' },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/onboarding/pacing-profile',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { profileKey: 'standard' },
    });
    const consent = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/consent',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { accepted: true },
    });
    expect(consent.statusCode).toBe(200);

    const clientRow = await pool.query<{ consent_tos_version: string | null }>(
      `SELECT consent_tos_version FROM clients WHERE id = $1`,
      [client.clientId],
    );
    expect(clientRow.rows[0]!.consent_tos_version).toBe(TOS_VERSION);

    const auditRows = await pool.query<{ metadata: { tos_version?: string } | null }>(
      `SELECT metadata FROM audit_logs
        WHERE client_id = $1 AND action = 'onboarding.consent_attested'`,
      [client.clientId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0]!.metadata?.tos_version).toBe(TOS_VERSION);

    const status = await app.inject({
      method: 'GET',
      url: '/v1/onboarding',
      headers: { authorization: `Bearer ${client.accessToken}` },
    });
    expect(status.statusCode).toBe(200);
    expect(
      (status.json() as { data: { consentTosVersion: string | null } }).data.consentTosVersion,
    ).toBe(TOS_VERSION);
  });
});
