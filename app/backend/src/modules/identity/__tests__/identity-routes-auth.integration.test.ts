import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../../platform/redis.js';
import { registerRoute } from '../../../platform/http/route-policy.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import { getUserTotpState } from '../identity.repo.js';
import {
  buildIdentityApp,
  buildTestConfig,
  cleanupCreatedIdentityRecords,
  STRONG_PASSWORD,
  uniqueEmail,
  uniqueIp,
} from './identity-routes-test-support.js';

/**
 * identity-routes-auth.integration.test.ts - signup/verify/login/refresh/
 * logout, the 429 shape, the oversized-body 413, and the MFA-enrol-required
 * gate. Contract/trust-proxy/PII: identity-routes-hardening.test.ts. Totp:
 * identity-routes-totp.test.ts. Fixtures: identity-routes-test-support.ts.
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

  const config = buildTestConfig({
    RATE_LIMIT_AUTH_IP_CAPACITY: '3',
    RATE_LIMIT_AUTH_IP_WINDOW_SEC: '900',
    RATE_LIMIT_AUTH_ACCOUNT_CAPACITY: '3',
    RATE_LIMIT_AUTH_ACCOUNT_WINDOW_SEC: '900',
    // Many distinct IPs needed (`uniqueIp()` isolation) - config-driven, never hard-coded.
    TRUST_PROXY: 'true',
  });

  app = await buildIdentityApp(
    {
      pool,
      tenantDb,
      redis,
      config,
      mailer: {
        sendVerificationEmail: async (to, verifyUrl) => {
          sentVerificationUrls.set(to, verifyUrl);
        },
        sendLockoutEmail: async () => {},
        sendReuseDetectedEmail: async () => {},
        sendPasswordResetEmail: async () => {},
      },
    },
    // The stub 'session_mfa' route below must register BEFORE the app boots.
    { ready: false },
  );

  // A single stub 'session_mfa' route registered THROUGH the same
  // `registerRoute` mechanism the real routes use - no production route
  // carries 'session_mfa' this session (see the phase task); this is only
  // to prove the policy mechanism itself.
  const stubAuthDeps: AuthDeps = {
    tokenEpochCtx: {
      redis,
      db: pool,
      jwtSecret: config.AUTH_JWT_SECRET,
      epochCacheTtlSec: config.EPOCH_CACHE_TTL_SEC,
      env: config.NODE_ENV,
    },
    db: pool,
    hasTotpEnrolled: async (userId: string) =>
      Boolean((await getUserTotpState(pool, userId))?.mfaEnabledAt),
  };
  registerRoute(app, stubAuthDeps, {
    method: 'GET',
    path: '/v1/__test/session-mfa-stub',
    policy: 'session_mfa',
    scope: 'test:stub',
    handler: (_req, reply) => {
      reply.send({ ok: true });
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await cleanupCreatedIdentityRecords(pool, redis, createdUserIds, createdClientIds);
  redis.disconnect();
  await pool.end();
});

async function signupViaHttp(
  label: string,
): Promise<{ userId: string; clientId: string; email: string }> {
  const email = uniqueEmail(label);
  const response = await app.inject({
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
  expect(response.statusCode).toBe(201);
  const body = response.json() as { data: { userId: string; clientId: string } };
  createdUserIds.push(body.data.userId);
  createdClientIds.push(body.data.clientId);
  return { userId: body.data.userId, clientId: body.data.clientId, email };
}

describe('identity routes (P04a Unit UA6, HTTP wiring)', () => {
  it('login_route_returns_a_real_429_with_headers', async () => {
    const ip = uniqueIp();
    const email = uniqueEmail('rate-limit');

    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'x-forwarded-for': ip },
        payload: { email, password: STRONG_PASSWORD },
      });
      expect(response.statusCode).not.toBe(429);
    }

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': ip },
      payload: { email, password: STRONG_PASSWORD },
    });

    expect(denied.statusCode).toBe(429);
    expect(denied.headers['retry-after']).toBeDefined();
    expect(denied.headers['ratelimit-limit']).toBe('3');
    expect(denied.headers['ratelimit-remaining']).toBe('0');
    expect(denied.headers['ratelimit-reset']).toBeDefined();
    const body = denied.json() as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.requestId).toBeTruthy();
  });

  it('an_oversized_body_is_rejected_before_any_db_work', async () => {
    // Fastify's default `bodyLimit` (1 MiB) is the HTTP boundary this repo
    // relies on since no explicit `bodyLimit` is configured anywhere - a
    // >1 MiB payload must be rejected (413) by Fastify's own body parser
    // before signup's rate-limit check or any DB write ever runs. Proven by
    // the absence of a created user for this email, not just the status code.
    const email = uniqueEmail('oversized-body');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: {
        fullName: 'Oversized Body',
        email,
        phoneE164: '+919876543210',
        companyName: 'Oversized Body Co',
        password: STRONG_PASSWORD,
        // Padding field well past the schema's own field-length limits -
        // the point is to blow the raw body size, not any one field.
        __padding: 'x'.repeat(2 * 1024 * 1024),
      },
    });

    expect(response.statusCode).toBe(413);

    const users = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    expect(users.rows).toHaveLength(0);
  });

  it('owner_without_totp_cannot_reach_a_protected_route', async () => {
    const { email } = await signupViaHttp('owner-no-totp');

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { email, password: STRONG_PASSWORD },
    });
    expect(loginResponse.statusCode).toBe(200);
    const loginBody = loginResponse.json() as { data: { kind: string; accessToken: string } };
    expect(loginBody.data.kind).toBe('authenticated');

    const stubResponse = await app.inject({
      method: 'GET',
      url: '/v1/__test/session-mfa-stub',
      headers: { authorization: `Bearer ${loginBody.data.accessToken}` },
    });

    expect(stubResponse.statusCode).toBe(403);
    const body = stubResponse.json() as { error: { code: string } };
    expect(body.error.code).toBe('MFA_ENROLL_REQUIRED');
  });

  it('signup_verify_login_refresh_logout_end_to_end_over_http', async () => {
    const { userId, email } = await signupViaHttp('e2e');

    const verifyUrl = sentVerificationUrls.get(email);
    expect(verifyUrl).toBeTruthy();
    const token = new URL(verifyUrl!).searchParams.get('token');
    expect(token).toBeTruthy();

    const verifyResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token },
    });
    expect(verifyResponse.statusCode).toBe(200);

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { email, password: STRONG_PASSWORD },
    });
    expect(loginResponse.statusCode).toBe(200);
    const loginBody = loginResponse.json() as { data: { kind: string; accessToken: string } };
    expect(loginBody.data.kind).toBe('authenticated');
    const oldAccessToken = loginBody.data.accessToken;

    const setCookieHeader = loginResponse.headers['set-cookie'];
    const rawCookie = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    expect(rawCookie).toContain('wp_refresh=');
    expect(rawCookie).toContain('HttpOnly');
    expect(rawCookie).toContain('SameSite=Strict');
    expect(rawCookie).toContain('Path=/v1/auth');
    const refreshCookieValue = /wp_refresh=([^;]+)/.exec(rawCookie!)![1]!;

    const meResponse = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${oldAccessToken}` },
    });
    expect(meResponse.statusCode).toBe(200);
    const meBody = meResponse.json() as {
      data: { user: { id: string; mfaEnabledAt: string | null } };
    };
    expect(meBody.data.user.id).toBe(userId);
    expect(meBody.data.user.mfaEnabledAt).toBeNull();

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: `wp_refresh=${refreshCookieValue}` },
    });
    expect(refreshResponse.statusCode).toBe(200);
    const refreshBody = refreshResponse.json() as { data: { accessToken: string } };
    expect(refreshBody.data.accessToken).toBeTruthy();
    expect(refreshBody.data.accessToken).not.toBe(oldAccessToken);

    const rotatedSetCookie = refreshResponse.headers['set-cookie'];
    const rotatedRawCookie = Array.isArray(rotatedSetCookie)
      ? rotatedSetCookie[0]
      : rotatedSetCookie;
    const rotatedRefreshValue = /wp_refresh=([^;]+)/.exec(rotatedRawCookie!)![1]!;
    expect(rotatedRefreshValue).not.toBe(refreshCookieValue);

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${refreshBody.data.accessToken}` },
    });
    expect(logoutResponse.statusCode).toBe(200);

    // The OLD access token (pre-logout) is now unverifiable (epoch bump).
    const meWithOldToken = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${oldAccessToken}` },
    });
    expect(meWithOldToken.statusCode).toBe(401);

    // The rotated refresh cookie no longer refreshes either (revoked at logout).
    const refreshAfterLogout = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: `wp_refresh=${rotatedRefreshValue}` },
    });
    expect(refreshAfterLogout.statusCode).toBe(401);
  });
});
