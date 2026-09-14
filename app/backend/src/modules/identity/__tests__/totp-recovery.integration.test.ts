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
 * totp-recovery.integration.test.ts (P04b Unit UB1a, task 2) - the
 * `/v1/auth/totp/recovery` route: one-time-use recovery-code login,
 * rate-limiting and the shared lockout ladder. Mirrors
 * identity-routes-totp.integration.test.ts's fixtures/shape exactly (a
 * dedicated `appRecoveryLockout` with a low lockout threshold + generous
 * rate-limit capacity, plus the reused main `app` for the rate-limit test).
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
let appRecoveryLockout: FastifyInstance;

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
    RATE_LIMIT_AUTH_IP_CAPACITY: '3',
    RATE_LIMIT_AUTH_IP_WINDOW_SEC: '900',
    RATE_LIMIT_AUTH_ACCOUNT_CAPACITY: '3',
    RATE_LIMIT_AUTH_ACCOUNT_WINDOW_SEC: '900',
    TRUST_PROXY: 'true',
  });
  app = await buildIdentityApp({ pool, tenantDb, redis, config });

  const configRecoveryLockout = buildTestConfig({
    RATE_LIMIT_AUTH_IP_CAPACITY: '50',
    RATE_LIMIT_AUTH_IP_WINDOW_SEC: '900',
    RATE_LIMIT_AUTH_ACCOUNT_CAPACITY: '50',
    RATE_LIMIT_AUTH_ACCOUNT_WINDOW_SEC: '900',
    AUTH_LOCKOUT_THRESHOLD: '3',
    AUTH_LOCKOUT_BASE_MINUTES: '15',
    AUTH_LOCKOUT_MAX_HOURS: '24',
    TRUST_PROXY: 'true',
  });
  appRecoveryLockout = await buildIdentityApp({
    pool,
    tenantDb,
    redis,
    config: configRecoveryLockout,
  });
});

afterAll(async () => {
  await app.close();
  await appRecoveryLockout.close();
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

/** Signup -> login -> TOTP enrol/confirm over HTTP -> a FRESH mfa-challenge login, on `appRecoveryLockout`. Returns the raw recovery codes too. */
async function signupAndEnrolTotpViaHttp(label: string): Promise<{
  userId: string;
  email: string;
  mfaToken: string;
  recoveryCodes: string[];
}> {
  const email = uniqueEmail(label);
  const signupResponse = await appRecoveryLockout.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: {
      fullName: `Recovery Route ${label}`,
      email,
      phoneE164: '+919876543210',
      companyName: `Recovery Route Co ${label}`,
      password: STRONG_PASSWORD,
    },
  });
  expect(signupResponse.statusCode).toBe(201);
  const signupBody = signupResponse.json() as { data: { userId: string; clientId: string } };
  createdUserIds.push(signupBody.data.userId);
  createdClientIds.push(signupBody.data.clientId);

  const firstLogin = await appRecoveryLockout.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: { email, password: STRONG_PASSWORD },
  });
  expect(firstLogin.statusCode).toBe(200);
  const firstLoginBody = firstLogin.json() as { data: { accessToken: string } };

  const enrolStartResponse = await appRecoveryLockout.inject({
    method: 'POST',
    url: '/v1/auth/totp/enrol',
    headers: { authorization: `Bearer ${firstLoginBody.data.accessToken}` },
  });
  expect(enrolStartResponse.statusCode).toBe(200);
  const enrolStartBody = enrolStartResponse.json() as { data: { secretShownOnce: string } };
  const secret = enrolStartBody.data.secretShownOnce;

  const confirmResponse = await appRecoveryLockout.inject({
    method: 'POST',
    url: '/v1/auth/totp/enrol/confirm',
    headers: { authorization: `Bearer ${firstLoginBody.data.accessToken}` },
    payload: { code: await otpGenerate({ secret }) },
  });
  expect(confirmResponse.statusCode).toBe(200);
  const confirmBody = confirmResponse.json() as { data: { recoveryCodes: string[] } };

  const secondLogin = await appRecoveryLockout.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: { email, password: STRONG_PASSWORD },
  });
  expect(secondLogin.statusCode).toBe(200);
  const secondLoginBody = secondLogin.json() as { data: { kind: string; mfaToken: string } };
  expect(secondLoginBody.data.kind).toBe('mfa_required');

  return {
    userId: signupBody.data.userId,
    email,
    mfaToken: secondLoginBody.data.mfaToken,
    recoveryCodes: confirmBody.data.recoveryCodes,
  };
}

describe('totp-recovery route (P04b Unit UB1a, task 2)', () => {
  it('a_recovery_code_logs_in_once_and_the_same_code_never_works_twice', async () => {
    const { userId, mfaToken, recoveryCodes } = await signupAndEnrolTotpViaHttp('recovery-once');
    const code = recoveryCodes[0]!;

    const first = await appRecoveryLockout.inject({
      method: 'POST',
      url: '/v1/auth/totp/recovery',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { mfaToken, recoveryCode: code },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { data: { kind: string } };
    expect(firstBody.data.kind).toBe('authenticated');

    // Storage-layer proof: exactly one row claimed (`used_at` set once).
    const claimed = await pool.query<{ used_at: Date | null }>(
      'SELECT used_at FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL',
      [userId],
    );
    expect(claimed.rows).toHaveLength(1);

    // A FRESH mfaToken (a new jti) presenting the SAME already-used code -
    // must fail with the SAME generic error shape as a wrong code (no
    // oracle distinguishing "already used" from "wrong").
    const freshMfaToken = await signTestMfaToken(userId);
    const replay = await appRecoveryLockout.inject({
      method: 'POST',
      url: '/v1/auth/totp/recovery',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { mfaToken: freshMfaToken, recoveryCode: code },
    });
    expect(replay.statusCode).toBe(400);
    const replayBody = replay.json() as { error: { code: string } };
    expect(replayBody.error.code).toBe('VALIDATION_ERROR');

    // used_at is still set exactly once - the replay never re-claimed it.
    const stillClaimed = await pool.query<{ used_at: Date | null }>(
      'SELECT used_at FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL',
      [userId],
    );
    expect(stillClaimed.rows).toHaveLength(1);
  });

  it('recovery_route_is_rate_limited_and_feeds_the_lockout_ladder', async () => {
    // Rate limit (mirrors totp/verify's own 429 test): reuses the main
    // `app`/`config` (IP+account capacity 3) - a well-formed-but-fake
    // mfaToken is enough, rate limiting runs before any DB lookup.
    const ip = uniqueIp();
    const fakeMfaToken = await signTestMfaToken(randomUUID());

    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/totp/recovery',
        headers: { 'x-forwarded-for': ip },
        payload: { mfaToken: fakeMfaToken, recoveryCode: 'WRONGCODE1' },
      });
      expect(response.statusCode).not.toBe(429);
    }
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/recovery',
      headers: { 'x-forwarded-for': ip },
      payload: { mfaToken: fakeMfaToken, recoveryCode: 'WRONGCODE1' },
    });
    expect(denied.statusCode).toBe(429);
    expect(denied.headers['retry-after']).toBeDefined();
    const deniedBody = denied.json() as { error: { code: string } };
    expect(deniedBody.error.code).toBe('RATE_LIMITED');

    // Lockout ladder: wrong recovery codes increment the SAME ladder as
    // wrong TOTP codes (AUTH_LOCKOUT_THRESHOLD=3 on appRecoveryLockout) - a
    // locked account then denies even a genuinely VALID recovery code.
    const { mfaToken, recoveryCodes } = await signupAndEnrolTotpViaHttp('recovery-lockout');

    for (let i = 0; i < 3; i += 1) {
      const response = await appRecoveryLockout.inject({
        method: 'POST',
        url: '/v1/auth/totp/recovery',
        headers: { 'x-forwarded-for': uniqueIp() },
        payload: { mfaToken, recoveryCode: 'TOTALLYWRONG' },
      });
      expect(response.statusCode).toBe(400);
    }

    const stillLocked = await appRecoveryLockout.inject({
      method: 'POST',
      url: '/v1/auth/totp/recovery',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { mfaToken, recoveryCode: recoveryCodes[1]! },
    });
    const lockedBody = stillLocked.json() as { error: { code: string } };
    expect(lockedBody.error.code).toBe('ACCOUNT_LOCKED');
    expect(stillLocked.statusCode).toBe(403);
  });
});
