import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPassword } from './password.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import {
  buildIdentityApp,
  buildTestConfig,
  cleanupCreatedIdentityRecords,
  uniqueEmail,
  uniqueIp,
} from './__tests__/identity-routes-test-support.js';
import { onboardedMfaClient } from './__tests__/identity-routes-mfa-helpers.js';

/**
 * password-reset.routes.integration.test.ts (P28 U5, item 1; split out of
 * password.routes.integration.test.ts for max-lines) - the forgot/reset
 * halves of the flow: the existence-oracle-safe forgot flow, and the reset
 * flow's token-consumption/epoch-bump/full-session-kill. `change_password`
 * and the rate-limit proofs live in the sibling
 * password.routes.integration.test.ts. Own beforeAll/afterAll (independent
 * fixture, same split idiom `contacts-api-limits-and-tags.integration.test.ts`'s
 * own header comment documents).
 */

const NEW_PASSWORD = 'Even-Stronger-Password-42!';

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
const sentVerificationUrls = new Map<string, string>();
const sentPasswordResetUrls: { to: string; resetUrl: string }[] = [];

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
      sendPasswordResetEmail: async (to, resetUrl) => {
        sentPasswordResetUrls.push({ to, resetUrl });
      },
    },
  });
});

afterAll(async () => {
  await app.close();
  await pool.query('DELETE FROM password_reset_tokens WHERE user_id = ANY($1)', [createdUserIds]);
  await cleanupCreatedIdentityRecords(pool, redis, createdUserIds, createdClientIds);
  redis.disconnect();
  await pool.end();
});

function resetUrlFor(email: string): string | undefined {
  return sentPasswordResetUrls.find((m) => m.to === email)?.resetUrl;
}

function tokenFromResetUrl(resetUrl: string): string {
  const token = new URL(resetUrl).searchParams.get('token');
  if (!token) throw new Error(`reset URL carried no token: ${resetUrl}`);
  return token;
}

describe('password routes: forgot/reset (P28 U5, item 1)', () => {
  it('forgot_password_never_reveals_whether_the_account_exists', async () => {
    const unknownEmail = uniqueEmail('forgot-unknown');
    const unknownResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/forgot',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { email: unknownEmail },
    });
    expect(unknownResponse.statusCode).toBe(202);
    expect(unknownResponse.json()).toMatchObject({ data: { accepted: true } });
    expect(resetUrlFor(unknownEmail)).toBeUndefined();

    const { client } = await onboardedMfaClient(app, sentVerificationUrls, 'forgot-known');
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    const knownResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/forgot',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { email: client.email },
    });
    expect(knownResponse.statusCode).toBe(202);
    expect(knownResponse.json()).toMatchObject({ data: { accepted: true } });

    const firstResetUrl = resetUrlFor(client.email);
    expect(firstResetUrl).toBeTruthy();
    const firstToken = tokenFromResetUrl(firstResetUrl!);
    const firstTokenHash = createHash('sha256').update(Buffer.from(firstToken, 'hex')).digest();

    const tokenRows = await pool.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM password_reset_tokens WHERE user_id = $1 AND consumed_at IS NULL',
      [client.userId],
    );
    expect(tokenRows.rows).toHaveLength(1);
    expect(Buffer.compare(tokenRows.rows[0]!.token_hash, firstTokenHash)).toBe(0);

    // A second request invalidates the first token.
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/forgot',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { email: client.email },
    });
    expect(secondResponse.statusCode).toBe(202);

    const firstTokenRow = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM password_reset_tokens WHERE token_hash = $1',
      [firstTokenHash],
    );
    expect(firstTokenRow.rows[0]!.consumed_at).not.toBeNull();

    const unconsumedRows = await pool.query(
      'SELECT id FROM password_reset_tokens WHERE user_id = $1 AND consumed_at IS NULL',
      [client.userId],
    );
    expect(unconsumedRows.rows).toHaveLength(1);
  });

  it('reset_password_consumes_the_token_and_kills_every_session', async () => {
    const { client, mfaAccessToken } = await onboardedMfaClient(
      app,
      sentVerificationUrls,
      'reset-flow',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);

    const forgotResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/forgot',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { email: client.email },
    });
    expect(forgotResponse.statusCode).toBe(202);
    const resetUrl = resetUrlFor(client.email);
    expect(resetUrl).toBeTruthy();
    const token = tokenFromResetUrl(resetUrl!);

    const oldEpochRow = await pool.query<{ token_epoch: number }>(
      'SELECT token_epoch FROM users WHERE id = $1',
      [client.userId],
    );
    const oldEpoch = oldEpochRow.rows[0]!.token_epoch;

    const resetResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/reset',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { token, newPassword: NEW_PASSWORD },
    });
    expect(resetResponse.statusCode).toBe(200);
    expect(resetResponse.json()).toMatchObject({ data: { reset: true } });

    const newHashRow = await pool.query<{ password_hash: string; token_epoch: number }>(
      'SELECT password_hash, token_epoch FROM users WHERE id = $1',
      [client.userId],
    );
    expect(await verifyPassword(newHashRow.rows[0]!.password_hash, NEW_PASSWORD)).toBe(true);
    expect(newHashRow.rows[0]!.token_epoch).toBe(oldEpoch + 1);

    const consumedRow = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [client.userId],
    );
    expect(consumedRow.rows[0]!.consumed_at).not.toBeNull();

    // Every session's access token (including the one used to mint the
    // forgot request above) -> 401 now.
    const meResponse = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(meResponse.statusCode).toBe(401);

    // Same token again -> 400.
    const replayResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/reset',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { token, newPassword: 'Another-Password-99!' },
    });
    expect(replayResponse.statusCode).toBe(400);
    expect(replayResponse.json().error.details.reason).toBe('invalid_or_expired_token');

    // Expired token -> 400.
    const expiredTokenId = randomUUID();
    const expiredRawToken = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const expiredHash = createHash('sha256').update(Buffer.from(expiredRawToken, 'hex')).digest();
    await pool.query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() - interval '1 minute')`,
      [expiredTokenId, client.userId, expiredHash],
    );
    const expiredResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/reset',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { token: expiredRawToken, newPassword: 'Another-Password-99!' },
    });
    expect(expiredResponse.statusCode).toBe(400);
    expect(expiredResponse.json().error.details.reason).toBe('invalid_or_expired_token');

    // Malformed -> 400 (contract validation, too short).
    const malformedResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/reset',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { token: 'short', newPassword: 'Another-Password-99!' },
    });
    expect(malformedResponse.statusCode).toBe(400);
  });
});
