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
import { setConsent, type OnboardingCtx } from '../onboarding.service.js';

/**
 * onboarding-edge-cases.integration.test.ts (C2 hardening pass, P04b) -
 * concurrency/idempotency edges NOT covered by onboarding.integration.
 * test.ts's happy-path + basic-replay proof: concurrent double-advance
 * (exactly one winner, no double audit row), two-tenant interference under
 * concurrent load, and a crash mid-consent-transaction (rollback leaves
 * neither the attestation columns nor the audit row). Boundary/malformed-
 * input validation edges live in the sibling
 * onboarding-boundary-cases.integration.test.ts (split for max-lines).
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

async function advanceToAttestConsent(accessToken: string): Promise<void> {
  await app.inject({
    method: 'POST',
    url: '/v1/onboarding/timezone',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { timezone: 'Asia/Kolkata' },
  });
  await app.inject({
    method: 'POST',
    url: '/v1/onboarding/pacing-profile',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { profileKey: 'standard' },
  });
}

describe('onboarding step machine - concurrency/idempotency/boundary edges', () => {
  it('two_concurrent_timezone_advances_exactly_one_wins_step_advances_once', async () => {
    const client = await onboardedMfaClient('concurrent-tz');

    const results = await Promise.allSettled([
      app.inject({
        method: 'POST',
        url: '/v1/onboarding/timezone',
        headers: { authorization: `Bearer ${client.accessToken}` },
        payload: { timezone: 'Asia/Kolkata' },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/onboarding/timezone',
        headers: { authorization: `Bearer ${client.accessToken}` },
        payload: { timezone: 'Asia/Kolkata' },
      }),
    ]);

    const statusCodes = results.map((r) => (r.status === 'fulfilled' ? r.value.statusCode : -1));
    // Both requests race the SAME conditional UPDATE (WHERE onboarding_step =
    // 'choose_timezone') - exactly one can match, the other gets 0 rows and
    // is mapped to a 409 CONFLICT (never a second silent "success").
    expect(statusCodes.filter((c) => c === 200)).toHaveLength(1);
    expect(statusCodes.filter((c) => c === 409)).toHaveLength(1);

    const row = await pool.query<{ onboarding_step: string }>(
      'SELECT onboarding_step FROM clients WHERE id = $1',
      [client.clientId],
    );
    // The step advanced EXACTLY one position, not twice/backwards.
    expect(row.rows[0]!.onboarding_step).toBe('accept_pacing_profile');
  });

  it('two_concurrent_consent_attestations_exactly_one_wins_and_exactly_one_audit_row_is_written', async () => {
    const client = await onboardedMfaClient('concurrent-consent');
    await advanceToAttestConsent(client.accessToken);

    const results = await Promise.allSettled([
      app.inject({
        method: 'POST',
        url: '/v1/onboarding/consent',
        headers: { authorization: `Bearer ${client.accessToken}` },
        payload: { accepted: true },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/onboarding/consent',
        headers: { authorization: `Bearer ${client.accessToken}` },
        payload: { accepted: true },
      }),
    ]);

    const statusCodes = results.map((r) => (r.status === 'fulfilled' ? r.value.statusCode : -1));
    expect(statusCodes.filter((c) => c === 200)).toHaveLength(1);
    expect(statusCodes.filter((c) => c === 409)).toHaveLength(1);

    const row = await pool.query<{ onboarding_step: string }>(
      'SELECT onboarding_step FROM clients WHERE id = $1',
      [client.clientId],
    );
    expect(row.rows[0]!.onboarding_step).toBe('connect_whatsapp');

    // No double audit row - the losing request must never have inserted its
    // own audit_logs row despite racing the same consent attestation.
    const auditRows = await pool.query<{ id: string }>(
      `SELECT id FROM audit_logs WHERE client_id = $1 AND action = 'onboarding.consent_attested'`,
      [client.clientId],
    );
    expect(auditRows.rows).toHaveLength(1);
  });

  it('replaying_an_already_applied_pacing_profile_advance_conflicts_with_current_step_state_unchanged', async () => {
    const client = await onboardedMfaClient('replay-pacing');
    await app.inject({
      method: 'POST',
      url: '/v1/onboarding/timezone',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { timezone: 'Asia/Kolkata' },
    });
    const first = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/pacing-profile',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { profileKey: 'standard' },
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/pacing-profile',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { profileKey: 'different-profile' },
    });
    expect(replay.statusCode).toBe(409);
    const replayBody = replay.json() as { error: { details?: { currentStep?: string } } };
    expect(replayBody.error.details?.currentStep).toBe('attest_consent');

    // State unchanged: the FIRST profileKey value is what persisted, the
    // replay's different value never overwrote it.
    const row = await pool.query<{ pacing_profile_key: string | null }>(
      'SELECT pacing_profile_key FROM clients WHERE id = $1',
      [client.clientId],
    );
    expect(row.rows[0]!.pacing_profile_key).toBe('standard');
  });

  it('tenant_a_advancing_under_concurrent_load_never_perturbs_tenant_b', async () => {
    const tenantA = await onboardedMfaClient('isolation-a');
    const tenantB = await onboardedMfaClient('isolation-b');

    // Tenant A fires a burst of concurrent (duplicate) timezone advances
    // while tenant B independently advances its own step once - tenant B's
    // step must reflect ONLY its own single advance, never affected by A's
    // concurrent load on a totally different client_id row.
    const [aResults, bResult] = await Promise.all([
      Promise.allSettled(
        Array.from({ length: 5 }, () =>
          app.inject({
            method: 'POST',
            url: '/v1/onboarding/timezone',
            headers: { authorization: `Bearer ${tenantA.accessToken}` },
            payload: { timezone: 'Asia/Kolkata' },
          }),
        ),
      ),
      app.inject({
        method: 'POST',
        url: '/v1/onboarding/timezone',
        headers: { authorization: `Bearer ${tenantB.accessToken}` },
        payload: { timezone: 'America/New_York' },
      }),
    ]);

    const aStatusCodes = aResults.map((r) => (r.status === 'fulfilled' ? r.value.statusCode : -1));
    expect(aStatusCodes.filter((c) => c === 200)).toHaveLength(1);

    expect(bResult.statusCode).toBe(200);

    const rowA = await pool.query<{ onboarding_step: string; timezone: string | null }>(
      'SELECT onboarding_step, timezone FROM clients WHERE id = $1',
      [tenantA.clientId],
    );
    expect(rowA.rows[0]!.onboarding_step).toBe('accept_pacing_profile');
    expect(rowA.rows[0]!.timezone).toBe('Asia/Kolkata');

    const rowB = await pool.query<{ onboarding_step: string; timezone: string | null }>(
      'SELECT onboarding_step, timezone FROM clients WHERE id = $1',
      [tenantB.clientId],
    );
    expect(rowB.rows[0]!.onboarding_step).toBe('accept_pacing_profile');
    expect(rowB.rows[0]!.timezone).toBe('America/New_York');
  });

  it('a_crash_between_the_consent_update_and_the_audit_insert_rolls_back_both_atomically', async () => {
    const client = await onboardedMfaClient('crash-mid-consent');
    await advanceToAttestConsent(client.accessToken);

    class InjectedCrash extends Error {}

    const onboardingCtx: OnboardingCtx = {
      pool,
      onboardingRepo: {
        // Fires AFTER the real conditional UPDATE has run (attestation
        // columns + step advance staged in the open transaction) but BEFORE
        // the audit_logs INSERT - proving the whole transaction rolls back,
        // never leaving an attested-but-unaudited client.
        insertConsentAuditLog: async () => {
          throw new InjectedCrash('simulated crash before the audit insert');
        },
      },
    };

    await expect(
      setConsent(onboardingCtx, { clientId: client.clientId, userId: client.userId }),
    ).rejects.toThrow(InjectedCrash);

    const row = await pool.query<{
      onboarding_step: string;
      consent_attested_at: Date | null;
      consent_attested_by_user_id: string | null;
    }>(
      'SELECT onboarding_step, consent_attested_at, consent_attested_by_user_id FROM clients WHERE id = $1',
      [client.clientId],
    );
    // Neither half committed - the step is still attest_consent, and the
    // attestation columns are still null (no attested-but-unaudited state).
    expect(row.rows[0]!.onboarding_step).toBe('attest_consent');
    expect(row.rows[0]!.consent_attested_at).toBeNull();
    expect(row.rows[0]!.consent_attested_by_user_id).toBeNull();

    const auditRows = await pool.query<{ id: string }>(
      `SELECT id FROM audit_logs WHERE client_id = $1 AND action = 'onboarding.consent_attested'`,
      [client.clientId],
    );
    // No audit-without-attestation either - zero rows, not a dangling one.
    expect(auditRows.rows).toHaveLength(0);

    // The real HTTP endpoint (uninjected) still works normally afterwards -
    // the crash did not corrupt the client's ability to complete the step.
    const consent = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/consent',
      headers: { authorization: `Bearer ${client.accessToken}` },
      payload: { accepted: true },
    });
    expect(consent.statusCode).toBe(200);
  });
});
