import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generate as otpGenerate } from 'otplib';
import type { createPool, TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import type { createRedis } from '../../../platform/redis.js';
import { loadConfig, type Config } from '../../../platform/config.js';
import { createRateLimiter } from '../../../platform/http/rate-limit.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import { buildApp } from '../../../platform/http/server.js';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { resolveRedisUrl } from '../../../platform/redis.js';
import {
  createRealtimeHub,
  failClosedInstanceOwnership,
  type RealtimeCtx,
} from '../../realtime/index.js';
import { getUserTotpState } from '../../identity/index.js';
import { createCountingNoOpRepairedSendSink } from '../../queue/index.js';

/**
 * tenancy-routes-test-support.ts (P04b Unit UB1b) - shared fixture helpers
 * for the tenancy integration tests. NOT itself a test file (no `.test.ts`
 * suffix). Boots the REAL production `buildApp` and drives identity state
 * over real HTTP - `no-deep-module-import` forbids importing
 * `modules/identity/<sibling>.js` from under `modules/tenancy/__tests__/`.
 */

export const JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long!!';
export const REDUCED_ARGON2 = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
export const STRONG_PASSWORD = 'Correct-Horse-Battery-Staple-9!';

export function uniqueEmail(label: string): string {
  return `tenancy-${label}-${randomUUID()}@example.test`;
}

export function uniqueIp(): string {
  const n = (): string => String(1 + Math.floor(Math.random() * 254));
  return `10.${n()}.${n()}.${n()}`;
}

export function buildTestConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: resolveDatabaseUrl(),
    REDIS_URL: resolveRedisUrl(),
    AUTH_JWT_SECRET: JWT_SECRET,
    ARGON2_MEMORY_KIB: String(REDUCED_ARGON2.memoryCost),
    ARGON2_TIME_COST: String(REDUCED_ARGON2.timeCost),
    ARGON2_PARALLELISM: String(REDUCED_ARGON2.parallelism),
    RATE_LIMIT_AUTH_IP_CAPACITY: '200',
    RATE_LIMIT_AUTH_IP_WINDOW_SEC: '900',
    RATE_LIMIT_AUTH_ACCOUNT_CAPACITY: '200',
    RATE_LIMIT_AUTH_ACCOUNT_WINDOW_SEC: '900',
    TRUST_PROXY: 'true',
    ...overrides,
  });
}

export interface BuildTenancyAppDeps {
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  redis: ReturnType<typeof createRedis>;
  config: Config;
  /** Captures each signup's verify URL, keyed by recipient email - see signupClientViaHttp. */
  sentVerificationUrls: Map<string, string>;
}

/** P14 Unit U4: `MessagesRoutesDeps` grew a required `keyProvider` - this fixture never exercises `/v1/messages` itself (see the `messages:` binding below), so a never-called stub is enough (same "not exercised, minimal shape" precedent as `messages`/`realtime`/`unresolved` elsewhere in this file). */
function stubKeyProvider(): KeyProvider {
  return {
    getActive: () => {
      throw new Error('stubKeyProvider: not exercised by this fixture');
    },
    get: () => {
      throw new Error('stubKeyProvider: not exercised by this fixture');
    },
  };
}

/** The REAL production app (identity + onboarding + instances) - same `buildApp` roles/api.ts wires in production. */
export async function buildTenancyApp(deps: BuildTenancyAppDeps): Promise<FastifyInstance> {
  const authDeps: AuthDeps = {
    tokenEpochCtx: {
      redis: deps.redis,
      db: deps.pool,
      jwtSecret: deps.config.AUTH_JWT_SECRET,
      epochCacheTtlSec: deps.config.EPOCH_CACHE_TTL_SEC,
      env: deps.config.NODE_ENV,
    },
    db: deps.pool,
    hasTotpEnrolled: async (userId: string) => {
      const state = await getUserTotpState(deps.pool, userId);
      return Boolean(state?.mfaEnabledAt);
    },
  };

  return buildApp({
    identity: {
      pool: deps.pool,
      tenantDb: deps.tenantDb,
      redis: deps.redis,
      rateLimiter: createRateLimiter(deps.redis),
      config: deps.config,
      mailer: {
        sendVerificationEmail: async (to, verifyUrl) => {
          deps.sentVerificationUrls.set(to, verifyUrl);
        },
        sendLockoutEmail: async () => {},
        sendReuseDetectedEmail: async () => {},
        sendPasswordResetEmail: async () => {},
      },
    },
    onboarding: { onboardingCtx: { pool: deps.pool } },
    instances: { entitlementCtx: { pool: deps.pool }, tenantDb: deps.tenantDb },
    // P11 U3: required `messages` dep - never exercised here; minimal shape.
    messages: {
      entitlementCtx: { pool: deps.pool },
      tenantDb: deps.tenantDb,
      keyProvider: stubKeyProvider(),
    },
    realtime: {
      realtimeCtx: {
        hub: createRealtimeHub({ replayRingSize: 500 }),
        instanceOwnership: failClosedInstanceOwnership,
        maxConnectionsPerUser: 5,
        onSubscriptionRefused: () => {},
      } satisfies RealtimeCtx,
      heartbeatMs: 15000,
      maxBufferedFrames: 100,
    },
    // P12 U5: required `unresolved` dep - never exercised here; counting
    // no-op sink (same minimal-shape precedent as `messages`/`realtime`).
    unresolved: { tenantDb: deps.tenantDb, sink: createCountingNoOpRepairedSendSink() },
    authDeps,
  });
}

export interface SignedUpClient {
  userId: string;
  clientId: string;
  email: string;
}

/** Signs up a fresh client over HTTP - email NOT yet verified. */
export async function signupClientViaHttp(
  app: FastifyInstance,
  label: string,
): Promise<SignedUpClient> {
  const email = uniqueEmail(label);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: {
      fullName: `Tenancy Test ${label}`,
      email,
      phoneE164: '+919876543210',
      companyName: `Tenancy Test Co ${label}`,
      password: STRONG_PASSWORD,
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`signup failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as { data: { userId: string; clientId: string } };
  return { userId: body.data.userId, clientId: body.data.clientId, email };
}

/** Verifies `email`'s address over HTTP - `sentVerificationUrls` is the SAME map passed into `buildTenancyApp`. */
export async function verifyClientEmailViaHttp(
  app: FastifyInstance,
  sentVerificationUrls: Map<string, string>,
  email: string,
): Promise<void> {
  const verifyUrl = sentVerificationUrls.get(email);
  if (!verifyUrl) throw new Error(`no captured verification URL for ${email}`);
  const rawToken = new URL(verifyUrl).searchParams.get('token');
  if (!rawToken) throw new Error(`verification URL for ${email} carried no token`);

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: rawToken },
  });
  if (response.statusCode !== 200) {
    throw new Error(`verify-email failed: ${response.statusCode} ${response.body}`);
  }
}

/** Logs in (no MFA yet) - returns the plain access token. */
export async function loginViaHttp(app: FastifyInstance, email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: { email, password: STRONG_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as {
    data: { kind: string; accessToken?: string };
  };
  if (body.data.kind !== 'authenticated' || !body.data.accessToken) {
    throw new Error(`login did not return an authenticated session: ${response.body}`);
  }
  return body.data.accessToken;
}

/** Enrols + confirms TOTP, then logs in again through the MFA continuation - returns a REAL `mfa: true` access token. */
export async function mintMfaAccessTokenViaHttp(
  app: FastifyInstance,
  email: string,
  plainAccessToken: string,
): Promise<string> {
  const enrolResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/totp/enrol',
    headers: { authorization: `Bearer ${plainAccessToken}` },
  });
  if (enrolResponse.statusCode !== 200) {
    throw new Error(`totp enrol failed: ${enrolResponse.statusCode} ${enrolResponse.body}`);
  }
  const enrolBody = enrolResponse.json() as { data: { secretShownOnce: string } };
  const secretShownOnce = enrolBody.data.secretShownOnce;
  const enrolCode: string = await otpGenerate({ secret: secretShownOnce });

  const confirmResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/totp/enrol/confirm',
    headers: { authorization: `Bearer ${plainAccessToken}` },
    payload: { code: enrolCode },
  });
  if (confirmResponse.statusCode !== 200) {
    throw new Error(`totp confirm failed: ${confirmResponse.statusCode} ${confirmResponse.body}`);
  }

  const loginResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: { email, password: STRONG_PASSWORD },
  });
  if (loginResponse.statusCode !== 200) {
    throw new Error(`mfa login failed: ${loginResponse.statusCode} ${loginResponse.body}`);
  }
  const loginBody = loginResponse.json() as { data: { kind: string; mfaToken?: string } };
  if (loginBody.data.kind !== 'mfa_required' || !loginBody.data.mfaToken) {
    throw new Error(`expected mfa_required after TOTP enrolment: ${loginResponse.body}`);
  }
  const mfaToken = loginBody.data.mfaToken;
  const verifyCode: string = await otpGenerate({ secret: secretShownOnce });

  const verifyResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/totp/verify',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: { mfaToken, code: verifyCode },
  });
  if (verifyResponse.statusCode !== 200) {
    throw new Error(`totp verify failed: ${verifyResponse.statusCode} ${verifyResponse.body}`);
  }
  const verifyBody = verifyResponse.json() as { data: { accessToken: string } };
  return verifyBody.data.accessToken;
}

/** Deletes every row `createdUserIds`/`createdClientIds` created, children-first. */
export async function cleanupTenancyRecords(
  pool: ReturnType<typeof createPool>,
  redis: ReturnType<typeof createRedis>,
  createdUserIds: string[],
  createdClientIds: string[],
): Promise<void> {
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM auth_sessions WHERE user_id = ANY($1)', [createdUserIds]);
    await pool.query('DELETE FROM mfa_recovery_codes WHERE user_id = ANY($1)', [createdUserIds]);
    await pool.query('DELETE FROM email_verification_tokens WHERE user_id = ANY($1)', [
      createdUserIds,
    ]);
    for (const userId of createdUserIds) {
      await redis.del(`test:epoch:u:${userId}`);
    }
  }
  if (createdClientIds.length > 0) {
    await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM wallet_ledger_ext_refs WHERE client_id = ANY($1)', [
      createdClientIds,
    ]);
    await pool.query('DELETE FROM wallet_ledger WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM client_pricing WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM memberships WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [createdClientIds]);
  }
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
}
