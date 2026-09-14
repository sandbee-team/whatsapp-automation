import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPassword } from './password.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import {
  buildIdentityApp,
  buildTestConfig,
  cleanupCreatedIdentityRecords,
  STRONG_PASSWORD,
  uniqueEmail,
  uniqueIp,
} from './__tests__/identity-routes-test-support.js';
import { onboardedMfaClient, mfaLoginViaHttp } from './__tests__/identity-routes-mfa-helpers.js';

/**
 * password.routes.integration.test.ts (P28 U5, item 1) - the password
 * change HTTP flow (wrong-current-password denial + session survival) and
 * the two rate limits. The forgot/reset halves live in the sibling
 * password-reset.routes.integration.test.ts (max-lines split).
 */

const NEW_PASSWORD = 'Even-Stronger-Password-42!';

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
    RATE_LIMIT_AUTH_IP_CAPACITY: '500',
    RATE_LIMIT_AUTH_IP_WINDOW_SEC: '900',
    RATE_LIMIT_AUTH_ACCOUNT_CAPACITY: '500',
    RATE_LIMIT_AUTH_ACCOUNT_WINDOW_SEC: '900',
    TRUST_PROXY: 'true',
  });

  app = await buildIdentityApp({
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
  });
});

afterAll(async () => {
  await app.close();
  await cleanupCreatedIdentityRecords(pool, redis, createdUserIds, createdClientIds);
  redis.disconnect();
  await pool.end();
});

describe('password routes: change + rate limits (P28 U5, item 1)', () => {
  it('change_password_requires_the_current_password_and_revokes_other_sessions', async () => {
    const { client, mfaAccessToken, totpSecret } = await onboardedMfaClient(
      app,
      sentVerificationUrls,
      'change',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    const originalHashRow = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [client.userId],
    );
    const originalHash = originalHashRow.rows[0]!.password_hash;

    // A second, independent MFA session (login) - used below to prove
    // change_password revokes OTHER sessions but keeps the current one alive.
    const { setCookieHeader: secondRawCookie } = await mfaLoginViaHttp(
      app,
      client.email,
      totpSecret,
    );
    const secondRefreshCookieValue = /wp_refresh=([^;]+)/.exec(secondRawCookie)![1]!;

    // Wrong current password -> 401, hash unchanged.
    const wrongResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { currentPassword: 'totally-wrong-password', newPassword: NEW_PASSWORD },
    });
    expect(wrongResponse.statusCode).toBe(401);
    expect(wrongResponse.json().error.details.field).toBe('currentPassword');

    const unchangedHashRow = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [client.userId],
    );
    expect(unchangedHashRow.rows[0]!.password_hash).toBe(originalHash);

    // Correct current password -> 200, hash changed.
    const changeResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { currentPassword: STRONG_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(changeResponse.statusCode).toBe(200);
    const changeBody = changeResponse.json() as {
      data: { changed: boolean; otherSessionsRevoked: number };
    };
    expect(changeBody.data.changed).toBe(true);
    // 2 OTHER sessions exist at this point: onboardedMfaClient's own
    // plain-login session (never MFA-verified, but still a live
    // auth_sessions row) plus the second MFA session minted above - never
    // the current (mfaAccessToken's own) session.
    expect(changeBody.data.otherSessionsRevoked).toBe(2);

    const newHashRow = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [client.userId],
    );
    expect(await verifyPassword(newHashRow.rows[0]!.password_hash, NEW_PASSWORD)).toBe(true);

    // The CURRENT session's own /v1/auth/me still 200 (never revoked, and
    // change_password never bumps token_epoch - see password.service.ts's
    // module doc comment). Checked BEFORE the other session's refresh below:
    // presenting an ALREADY-REVOKED refresh token is reuse-detection
    // (session.service.ts's `refresh()` canon), which revokes the user's
    // WHOLE session chain AND bumps token_epoch - a deliberately separate
    // security behavior from this test's own "the current session survives
    // a password change" assertion, so it must not run first.
    const meResponse = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(meResponse.statusCode).toBe(200);

    // The OTHER session's refresh -> 401 (revoked).
    const otherRefreshResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: `wp_refresh=${secondRefreshCookieValue}` },
    });
    expect(otherRefreshResponse.statusCode).toBe(401);

    // One audit row.
    const auditRows = await pool.query(
      "SELECT id FROM audit_logs WHERE client_id = $1 AND action = 'auth.password.change'",
      [client.clientId],
    );
    expect(auditRows.rows).toHaveLength(1);
  });

  it('password_routes_are_rate_limited', async () => {
    const { client, mfaAccessToken } = await onboardedMfaClient(
      app,
      sentVerificationUrls,
      'rate-limit',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    for (let i = 0; i < 5; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/change',
        headers: { authorization: `Bearer ${mfaAccessToken}` },
        payload: { currentPassword: 'wrong-password-again', newPassword: NEW_PASSWORD },
      });
      expect(response.statusCode).toBe(401);
    }
    const sixthResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { currentPassword: 'wrong-password-again', newPassword: NEW_PASSWORD },
    });
    expect(sixthResponse.statusCode).toBe(429);
    expect(sixthResponse.headers['retry-after']).toBeTruthy();
    expect(sixthResponse.headers['ratelimit-limit']).toBeTruthy();

    const forgotEmail = uniqueEmail('forgot-rate-limit');
    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/forgot',
        headers: { 'x-forwarded-for': uniqueIp() },
        payload: { email: forgotEmail },
      });
      expect(response.statusCode).toBe(202);
    }
    const fourthForgotResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/forgot',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { email: forgotEmail },
    });
    expect(fourthForgotResponse.statusCode).toBe(429);
  });
});
