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
 * identity-routes-totp.integration.test.ts (P04a Unit UA6 FIX 10; split
 * P04a FIXD out of identity-routes.integration.test.ts for max-lines) -
 * the `/v1/auth/totp/verify` rate-limit + lockout-ladder + single-use-jti
 * hardening tests. Pure move: no test case dropped, weakened or merged, no
 * assertion changed. Own Postgres/Redis/Fastify fixtures (independent of
 * the sibling identity-routes-auth.integration.test.ts's fixtures).
 * Fixture-building helpers live in identity-routes-test-support.ts.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
// Reused main app (IP+account capacity 3) - only for the rate-limit test
// below, which mirrors identity-routes-auth.integration.test.ts's own
// login_route_returns_a_real_429_with_headers.
let app: FastifyInstance;
// FIX 10 (P04a FIXB): a dedicated app with a low lockout threshold +
// generous rate-limit capacity, for the lockout-ladder + jti single-use
// tests below (a capacity of 3 is too small to drive a 5-failure lockout
// ladder without itself 429-ing first).
let appTotpLockout: FastifyInstance;

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

  // --- appTotpLockout (FIX 10) ---------------------------------------------
  const configTotpLockout = buildTestConfig({
    RATE_LIMIT_AUTH_IP_CAPACITY: '50',
    RATE_LIMIT_AUTH_IP_WINDOW_SEC: '900',
    RATE_LIMIT_AUTH_ACCOUNT_CAPACITY: '50',
    RATE_LIMIT_AUTH_ACCOUNT_WINDOW_SEC: '900',
    AUTH_LOCKOUT_THRESHOLD: '3',
    AUTH_LOCKOUT_BASE_MINUTES: '15',
    AUTH_LOCKOUT_MAX_HOURS: '24',
    TRUST_PROXY: 'true',
  });
  appTotpLockout = await buildIdentityApp({
    pool,
    tenantDb,
    redis,
    config: configTotpLockout,
  });
});

afterAll(async () => {
  await app.close();
  await appTotpLockout.close();
  await cleanupCreatedIdentityRecords(pool, redis, createdUserIds, createdClientIds);
  redis.disconnect();
  await pool.end();
});

/** FIX 10 (P04a FIXB) test helper: signs an mfaToken exactly like `identity.routes.ts`'s own `signMfaToken`. */
async function signTestMfaToken(userId: string, jti = randomUUID(), ttlMin = 5): Promise<string> {
  const secretKey = new TextEncoder().encode(JWT_SECRET);
  return new SignJWT({ purpose: 'mfa', jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${String(ttlMin)}m`)
    .sign(secretKey);
}

/**
 * FIX 10 (P04a FIXB) test helper: signup -> login (via `appTotpLockout`) ->
 * TOTP enrol/confirm over HTTP -> a FRESH mfa-challenge login. Returns the
 * enrolled user's id/email/secret and the mfaToken from that fresh login.
 */
async function signupAndEnrolTotpViaHttp(label: string): Promise<{
  userId: string;
  email: string;
  secret: string;
  mfaToken: string;
}> {
  const email = uniqueEmail(label);
  const signupResponse = await appTotpLockout.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: {
      fullName: `Identity Routes ${label}`,
      email,
      phoneE164: '+919876543210',
      companyName: `Identity Routes Co ${label}`,
      password: STRONG_PASSWORD,
    },
  });
  expect(signupResponse.statusCode).toBe(201);
  const signupBody = signupResponse.json() as { data: { userId: string; clientId: string } };
  createdUserIds.push(signupBody.data.userId);
  createdClientIds.push(signupBody.data.clientId);

  const firstLogin = await appTotpLockout.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: { email, password: STRONG_PASSWORD },
  });
  expect(firstLogin.statusCode).toBe(200);
  const firstLoginBody = firstLogin.json() as { data: { accessToken: string } };

  const enrolStartResponse = await appTotpLockout.inject({
    method: 'POST',
    url: '/v1/auth/totp/enrol',
    headers: { authorization: `Bearer ${firstLoginBody.data.accessToken}` },
  });
  expect(enrolStartResponse.statusCode).toBe(200);
  const enrolStartBody = enrolStartResponse.json() as { data: { secretShownOnce: string } };
  const secret = enrolStartBody.data.secretShownOnce;

  const confirmResponse = await appTotpLockout.inject({
    method: 'POST',
    url: '/v1/auth/totp/enrol/confirm',
    headers: { authorization: `Bearer ${firstLoginBody.data.accessToken}` },
    payload: { code: await otpGenerate({ secret }) },
  });
  expect(confirmResponse.statusCode).toBe(200);

  const secondLogin = await appTotpLockout.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: { email, password: STRONG_PASSWORD },
  });
  expect(secondLogin.statusCode).toBe(200);
  const secondLoginBody = secondLogin.json() as { data: { kind: string; mfaToken: string } };
  expect(secondLoginBody.data.kind).toBe('mfa_required');

  return { userId: signupBody.data.userId, email, secret, mfaToken: secondLoginBody.data.mfaToken };
}

describe('identity routes (P04a Unit UA6, HTTP wiring)', () => {
  describe('FIX 10 (P04a FIXB, /v1/auth/totp/verify hardening)', () => {
    it('totp_verify_route_returns_a_real_429_with_headers', async () => {
      // Reuses the main `app`/`config` (IP+account capacity 3) - mirrors
      // login_route_returns_a_real_429_with_headers above. Rate limiting
      // happens BEFORE any DB lookup, so a well-formed-but-fake mfaToken
      // (signed with the same JWT_SECRET) is enough to reach it.
      const ip = uniqueIp();
      const mfaToken = await signTestMfaToken(randomUUID());

      for (let i = 0; i < 3; i += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/auth/totp/verify',
          headers: { 'x-forwarded-for': ip },
          payload: { mfaToken, code: '000000' },
        });
        expect(response.statusCode).not.toBe(429);
      }

      const denied = await app.inject({
        method: 'POST',
        url: '/v1/auth/totp/verify',
        headers: { 'x-forwarded-for': ip },
        payload: { mfaToken, code: '000000' },
      });

      expect(denied.statusCode).toBe(429);
      expect(denied.headers['retry-after']).toBeDefined();
      expect(denied.headers['ratelimit-limit']).toBe('3');
      const body = denied.json() as { error: { code: string } };
      expect(body.error.code).toBe('RATE_LIMITED');
    });

    it('wrong_codes_lock_the_account_and_a_correct_code_is_then_denied_as_locked', async () => {
      const { mfaToken, secret } = await signupAndEnrolTotpViaHttp('totp-lockout');

      for (let i = 0; i < 3; i += 1) {
        const response = await appTotpLockout.inject({
          method: 'POST',
          url: '/v1/auth/totp/verify',
          headers: { 'x-forwarded-for': uniqueIp() },
          payload: { mfaToken, code: '000000' },
        });
        expect(response.statusCode).toBe(400);
      }

      // W4 (P04a FIXC): the 3rd failure (AUTH_LOCKOUT_THRESHOLD=3 on
      // appTotpLockout) locked the account - a REAL, currently-valid code
      // generated from the enrolled secret (not another wrong '000000') is
      // now denied as locked too. '000000' would pass this assertion even if
      // the lockout check ran AFTER the code check - only a genuinely correct
      // code proves the lockout gate runs first.
      const correctCode = await otpGenerate({ secret });
      const stillLocked = await appTotpLockout.inject({
        method: 'POST',
        url: '/v1/auth/totp/verify',
        headers: { 'x-forwarded-for': uniqueIp() },
        payload: { mfaToken, code: correctCode },
      });
      const lockedBody = stillLocked.json() as { error: { code: string } };
      expect(lockedBody.error.code).toBe('ACCOUNT_LOCKED');
      expect(stillLocked.statusCode).toBe(403);
    });

    it('a_consumed_mfa_token_jti_cannot_verify_again_even_with_a_fresh_valid_code', async () => {
      const { mfaToken, secret } = await signupAndEnrolTotpViaHttp('totp-jti-replay');

      const firstCode = await otpGenerate({ secret });
      const firstAttempt = await appTotpLockout.inject({
        method: 'POST',
        url: '/v1/auth/totp/verify',
        headers: { 'x-forwarded-for': uniqueIp() },
        payload: { mfaToken, code: firstCode },
      });
      expect(firstAttempt.statusCode).toBe(200);
      const firstBody = firstAttempt.json() as { data: { kind: string } };
      expect(firstBody.data.kind).toBe('authenticated');

      // A DIFFERENT (next-period) valid code, still within TOTP_WINDOW's
      // drift tolerance, against the SAME (already-consumed) mfaToken.
      // `otplib`'s `epoch` option is SECONDS, not milliseconds.
      const secondCode = await otpGenerate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
      const replay = await appTotpLockout.inject({
        method: 'POST',
        url: '/v1/auth/totp/verify',
        headers: { 'x-forwarded-for': uniqueIp() },
        payload: { mfaToken, code: secondCode },
      });
      expect(replay.statusCode).toBe(401);
      const replayBody = replay.json() as { error: { code: string } };
      expect(replayBody.error.code).toBe('UNAUTHENTICATED');
    });
  });
});
