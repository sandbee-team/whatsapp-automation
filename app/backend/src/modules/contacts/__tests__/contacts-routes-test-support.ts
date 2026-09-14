import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { createPool, TenantDb } from '@wp/db';
import { FileKeyProvider, KEK_PURPOSES, type KeyProvider } from '@wp/server-kit/crypto';
import type { createRedis } from '../../../platform/redis.js';
import { loadConfig, type Config } from '../../../platform/config.js';
import { createRateLimiter } from '../../../platform/http/rate-limit.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import { buildApp } from '../../../platform/http/server.js';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { resolveRedisUrl } from '../../../platform/redis.js';
import type { ObjectStore } from '../../../platform/storage/object-store.js';
import {
  createRealtimeHub,
  failClosedInstanceOwnership,
  type RealtimeCtx,
} from '../../realtime/index.js';
import { getUserTotpState } from '../../identity/index.js';
import { createCountingNoOpRepairedSendSink } from '../../queue/index.js';
import { mintMfaAccessTokenViaHttp } from './contacts-routes-mfa-support.js';

export { attachPlan, cleanupContactsRoutesRecords } from './contacts-routes-cleanup-support.js';
export { loginAndVerifyMfaViaHttp } from './contacts-routes-mfa-support.js';

/**
 * contacts-routes-test-support.ts (P20 Unit U4, step 4; extended P20 Unit
 * U6, step 5/7 with `contactImports`/the MFA-mint helper) - a per-module
 * fork of `wallet-routes-test-support.ts` (`no-deep-module-import` forbids
 * reaching into a sibling's `__tests__/**`). NOT itself a test file.
 */

export const JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long!!';
export const REDUCED_ARGON2 = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
export const STRONG_PASSWORD = 'Correct-Horse-Battery-Staple-9!';

export function uniqueEmail(label: string): string {
  return `contacts-${label}-${randomUUID()}@example.test`;
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

/**
 * Derived from `KEK_PURPOSES`, never hand-listed: `keyRingSchema`'s `active`
 * map is exhaustive over that enum, so a hard-coded copy silently rots into
 * `CRYPTO_KEY_RING_INVALID` the next time a purpose is added (it did, when
 * `api-key-pepper` landed on 2026-09-14).
 */
const RING_PURPOSES = KEK_PURPOSES;

/** Ad-hoc key-ring mounting every purpose, same shape as `phone-hash.test.ts`'s `makeProvider`. */
export function makePepperProvider(): KeyProvider {
  const dir = mkdtempSync(join(tmpdir(), 'wp-contacts-pepper-ring-'));
  const ringPath = join(dir, 'key-ring.json');
  const material = (byte: number): string => Buffer.alloc(32, byte).toString('base64');

  const active: Record<string, string> = {};
  const keys: Record<string, unknown> = {};
  RING_PURPOSES.forEach((purpose, i) => {
    const keyId = `k${i + 1}`;
    active[purpose] = keyId;
    keys[keyId] = { purpose, material: material(i + 1), created_at: '2026-01-01T00:00:00.000Z' };
  });
  writeFileSync(ringPath, JSON.stringify({ version: 1, active, keys }), 'utf8');

  return new FileKeyProvider({ ringPath, mountedPurposes: ['optout-pepper'] });
}

export interface BuildContactsAppDeps {
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  redis: ReturnType<typeof createRedis>;
  config: Config;
  sentVerificationUrls: Map<string, string>;
  keyProvider: KeyProvider;
  /** Optional (P20 Unit U6) - when omitted, the import upload/create/poll/cancel/errors routes are simply absent (404), same "optional dep" idiom as `server.ts`'s own `contactImports`. */
  objectStore?: ObjectStore;
}

/** The REAL production app (identity + onboarding + instances + contacts) - same `buildApp` roles/api.ts wires in production. */
export async function buildContactsApp(deps: BuildContactsAppDeps): Promise<FastifyInstance> {
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
      keyProvider: deps.keyProvider,
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
    contacts: { tenantDb: deps.tenantDb, keyProvider: deps.keyProvider },
    ...(deps.objectStore
      ? {
          contactImports: {
            tenantDb: deps.tenantDb,
            keyProvider: deps.keyProvider,
            objectStore: deps.objectStore,
          },
        }
      : {}),
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
      fullName: `Contacts Test ${label}`,
      email,
      phoneE164: '+919876543210',
      companyName: `Contacts Test Co ${label}`,
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

/** Signup -> verify -> mint MFA - ready to call any `session`/`session_mfa` route. `totpSecret` lets a caller re-mint a fresh MFA token later (e.g. after a role change - a fresh login re-reads `memberships.role`, unlike the already-issued token). */
export async function onboardedMfaClient(
  app: FastifyInstance,
  sentVerificationUrls: Map<string, string>,
  label: string,
): Promise<{ client: SignedUpClient; mfaAccessToken: string; totpSecret: string }> {
  const client = await signupClientViaHttp(app, label);
  await verifyClientEmailViaHttp(app, sentVerificationUrls, client.email);
  const plainAccessToken = await loginViaHttp(app, client.email);
  const { secretShownOnce, accessToken } = await mintMfaAccessTokenViaHttp(
    app,
    client.email,
    plainAccessToken,
    STRONG_PASSWORD,
    uniqueIp,
  );
  return { client, mfaAccessToken: accessToken, totpSecret: secretShownOnce };
}

/** Signup -> verify -> login. MFA is not needed for `session`-policy routes (this module's own routes), so this stops short of the MFA walk. */
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

// `attachPlan`/`cleanupContactsRoutesRecords` live in
// `contacts-routes-cleanup-support.ts` (300-line cap split) and are
// re-exported above so every existing import of this module keeps working.
