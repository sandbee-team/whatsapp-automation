import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { generate as otpGenerate } from 'otplib';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../../platform/redis.js';
import {
  buildIdentityApp,
  buildTestConfig,
  cleanupCreatedIdentityRecords,
  JWT_SECRET,
  STRONG_PASSWORD,
  uniqueEmail,
  uniqueIp,
} from './identity-routes-test-support.js';

/**
 * totp-recovery-edge-cases.integration.test.ts (C2 hardening pass, P04b) -
 * two edges NOT covered by totp-recovery.integration.test.ts's own
 * sequential-replay + lockout proofs: two CONCURRENT submissions of the
 * SAME still-valid recovery code (storage-layer one-time claim under a real
 * race, not a sequential replay), and a recovery code submitted against a
 * DIFFERENT user's mfaToken (must never leak whether the code belongs to
 * ANY account - the generic error, not a cross-user grant).
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());

  const config = buildTestConfig({
    RATE_LIMIT_AUTH_IP_CAPACITY: '50',
    RATE_LIMIT_AUTH_IP_WINDOW_SEC: '900',
    RATE_LIMIT_AUTH_ACCOUNT_CAPACITY: '50',
    RATE_LIMIT_AUTH_ACCOUNT_WINDOW_SEC: '900',
    TRUST_PROXY: 'true',
  });
  app = await buildIdentityApp({ pool, tenantDb, redis, config });
});

afterAll(async () => {
  await app.close();
  await cleanupCreatedIdentityRecords(pool, redis, createdUserIds, createdClientIds);
  redis.disconnect();
  await pool.end();
});

async function signTestMfaToken(userId: string, jti = randomUUID(), ttlMin = 5): Promise<string> {
  const secretKey = new TextEncoder().encode(JWT_SECRET);
  return new SignJWT({ purpose: 'mfa', jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${String(ttlMin)}m`)
    .sign(secretKey);
}

async function signupAndEnrolTotpViaHttp(label: string): Promise<{
  userId: string;
  email: string;
  recoveryCodes: string[];
}> {
  const email = uniqueEmail(label);
  const signupResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: {
      fullName: `Recovery Edge ${label}`,
      email,
      phoneE164: '+919876543210',
      companyName: `Recovery Edge Co ${label}`,
      password: STRONG_PASSWORD,
    },
  });
  expect(signupResponse.statusCode).toBe(201);
  const signupBody = signupResponse.json() as { data: { userId: string; clientId: string } };
  createdUserIds.push(signupBody.data.userId);
  createdClientIds.push(signupBody.data.clientId);

  const firstLogin = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: { email, password: STRONG_PASSWORD },
  });
  expect(firstLogin.statusCode).toBe(200);
  const firstLoginBody = firstLogin.json() as { data: { accessToken: string } };

  const enrolStartResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/totp/enrol',
    headers: { authorization: `Bearer ${firstLoginBody.data.accessToken}` },
  });
  expect(enrolStartResponse.statusCode).toBe(200);
  const enrolStartBody = enrolStartResponse.json() as { data: { secretShownOnce: string } };
  const secret = enrolStartBody.data.secretShownOnce;

  const confirmResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/totp/enrol/confirm',
    headers: { authorization: `Bearer ${firstLoginBody.data.accessToken}` },
    payload: { code: await otpGenerate({ secret }) },
  });
  expect(confirmResponse.statusCode).toBe(200);
  const confirmBody = confirmResponse.json() as { data: { recoveryCodes: string[] } };

  return { userId: signupBody.data.userId, email, recoveryCodes: confirmBody.data.recoveryCodes };
}

describe('totp-recovery route - concurrency and cross-user edges', () => {
  it('two_concurrent_submissions_of_the_same_recovery_code_exactly_one_session_is_minted', async () => {
    const { userId, recoveryCodes } = await signupAndEnrolTotpViaHttp('recovery-concurrent');
    const code = recoveryCodes[0]!;

    // Two DIFFERENT mfaTokens (different jti) so the jti single-use claim
    // does not itself explain a rejection - only the recovery-code claim
    // (identity.repo.ts#claimMfaRecoveryCode's conditional UPDATE) should.
    const mfaTokenA = await signTestMfaToken(userId);
    const mfaTokenB = await signTestMfaToken(userId);

    const results = await Promise.allSettled([
      app.inject({
        method: 'POST',
        url: '/v1/auth/totp/recovery',
        headers: { 'x-forwarded-for': uniqueIp() },
        payload: { mfaToken: mfaTokenA, recoveryCode: code },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/auth/totp/recovery',
        headers: { 'x-forwarded-for': uniqueIp() },
        payload: { mfaToken: mfaTokenB, recoveryCode: code },
      }),
    ]);

    const statusCodes = results.map((r) => (r.status === 'fulfilled' ? r.value.statusCode : -1));
    expect(statusCodes.filter((c) => c === 200)).toHaveLength(1);
    // The loser gets the SAME generic error shape as any wrong/used code -
    // no oracle distinguishing "someone else just claimed it" from "wrong".
    expect(statusCodes.filter((c) => c === 400)).toHaveLength(1);

    // Storage-layer proof: exactly one claim, never two, never zero.
    const claimed = await pool.query<{ used_at: Date | null }>(
      'SELECT used_at FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL',
      [userId],
    );
    expect(claimed.rows).toHaveLength(1);
  });

  it('a_recovery_code_submitted_against_a_different_users_mfaToken_gets_the_generic_failure_no_cross_user_leak', async () => {
    const owner = await signupAndEnrolTotpViaHttp('recovery-owner');
    const stranger = await signupAndEnrolTotpViaHttp('recovery-stranger');

    const strangerMfaToken = await signTestMfaToken(stranger.userId);
    const ownersCode = owner.recoveryCodes[0]!;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/recovery',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { mfaToken: strangerMfaToken, recoveryCode: ownersCode },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');

    // Neither account's recovery codes were consumed by the cross-user
    // attempt - the owner's code stays live, the stranger's account is
    // untouched.
    const ownerClaims = await pool.query<{ used_at: Date | null }>(
      'SELECT used_at FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL',
      [owner.userId],
    );
    expect(ownerClaims.rows).toHaveLength(0);

    const strangerClaims = await pool.query<{ used_at: Date | null }>(
      'SELECT used_at FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL',
      [stranger.userId],
    );
    expect(strangerClaims.rows).toHaveLength(0);

    // The owner's code still works normally afterwards (never silently
    // burned by the cross-user attempt).
    const ownerMfaToken = await signTestMfaToken(owner.userId);
    const ownerAttempt = await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/recovery',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { mfaToken: ownerMfaToken, recoveryCode: ownersCode },
    });
    expect(ownerAttempt.statusCode).toBe(200);
  });
});
