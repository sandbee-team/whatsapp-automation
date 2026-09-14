import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
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
 * list-query-coercion-app-support.ts (P28 U5, item 4) - a per-test-file
 * fixture combining notifications + wallet(topups) + broadcasts + groups +
 * contacts into ONE app (`no-deep-module-import` forbids reaching into a
 * sibling module's own `__tests__/**`, so this is a fresh, minimal build
 * rather than importing e.g. `wallet-routes-test-support.ts` directly - same
 * per-module-copy discipline the rest of this suite already follows). NOT
 * itself a test file.
 */

export const JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long!!';
export const REDUCED_ARGON2 = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
export const STRONG_PASSWORD = 'Correct-Horse-Battery-Staple-9!';

export function uniqueEmail(label: string): string {
  return `list-coercion-${label}-${randomUUID()}@example.test`;
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

/** Never exercised by this fixture (`/v1/messages`/`/v1/contacts` writes are out of scope) - same "not exercised, minimal shape" precedent `wallet-routes-test-support.ts`'s own stub uses. */
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

export interface BuildListCoercionAppDeps {
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  redis: ReturnType<typeof createRedis>;
  config: Config;
  sentVerificationUrls: Map<string, string>;
}

/** The REAL production app, with notifications/wallet/broadcasts/groups/contacts all wired - same `buildApp` roles/api.ts wires in production. */
export async function buildListCoercionApp(
  deps: BuildListCoercionAppDeps,
): Promise<FastifyInstance> {
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
    unresolved: { tenantDb: deps.tenantDb, sink: createCountingNoOpRepairedSendSink() },
    notifications: { tenantDb: deps.tenantDb },
    wallet: { tenantDb: deps.tenantDb },
    broadcasts: { tenantDb: deps.tenantDb, publishWake: () => undefined },
    groups: { tenantDb: deps.tenantDb },
    contacts: { tenantDb: deps.tenantDb, keyProvider: stubKeyProvider() },
    authDeps,
  });
}

export interface SignedUpClient {
  userId: string;
  clientId: string;
  email: string;
}

async function signupClientViaHttp(app: FastifyInstance, label: string): Promise<SignedUpClient> {
  const email = uniqueEmail(label);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: {
      fullName: `List Coercion Test ${label}`,
      email,
      phoneE164: '+919876543210',
      companyName: `List Coercion Test Co ${label}`,
      password: STRONG_PASSWORD,
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`signup failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as { data: { userId: string; clientId: string } };
  return { userId: body.data.userId, clientId: body.data.clientId, email };
}

async function verifyClientEmailViaHttp(
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

async function loginViaHttp(app: FastifyInstance, email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: { email, password: STRONG_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as { data: { kind: string; accessToken?: string } };
  if (body.data.kind !== 'authenticated' || !body.data.accessToken) {
    throw new Error(`login did not return an authenticated session: ${response.body}`);
  }
  return body.data.accessToken;
}

/** Signup -> verify -> login (session-policy only - no route this test exercises needs session_mfa). */
export async function onboardedClient(
  app: FastifyInstance,
  sentVerificationUrls: Map<string, string>,
  label: string,
): Promise<{ client: SignedUpClient; accessToken: string }> {
  const client = await signupClientViaHttp(app, label);
  await verifyClientEmailViaHttp(app, sentVerificationUrls, client.email);
  const accessToken = await loginViaHttp(app, client.email);
  return { client, accessToken };
}

// The direct-SQL seed/cleanup helpers (seedInstance/seedNotifications/
// seedTopupRequests/seedCampaigns/seedGroups/seedContacts/
// cleanupListCoercionRecords) live in the sibling list-query-coercion-
// seeds.ts (P28 U5, max-lines split) - re-exported here so
// list-query-coercion.integration.test.ts needs only one import for both
// halves.
export {
  seedInstance,
  seedNotifications,
  seedTopupRequests,
  seedCampaigns,
  seedGroups,
  seedContacts,
  cleanupListCoercionRecords,
} from './list-query-coercion-seeds.js';
