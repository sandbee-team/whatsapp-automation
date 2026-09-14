import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { createPool, TenantDb } from '@wp/db';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import type { createRedis } from '../../platform/redis.js';
import { loadConfig, type Config } from '../../platform/config.js';
import { createRateLimiter, type RateLimiter } from '../../platform/http/rate-limit.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { buildApp } from '../../platform/http/server.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { resolveRedisUrl } from '../../platform/redis.js';
import {
  createRealtimeHub,
  failClosedInstanceOwnership,
  type RealtimeCtx,
} from '../realtime/index.js';
import { getUserTotpState } from '../identity/index.js';
import { createCountingNoOpRepairedSendSink } from '../queue/index.js';
import { lookupByKeyPrefix } from './repo.js';

/**
 * api-keys-routes-test-support.ts (go-live U4) - the SAME `buildMessagesApp`-
 * shaped fixture layer as `modules/messages/enqueue-test-support.ts` (an
 * intentional per-module copy - `no-deep-module-import` forbids reaching into
 * another module's internals, and it does NOT exempt test-support files: an
 * earlier draft imported the signup/verify/MFA walk straight from
 * `../messages/enqueue-http-auth-helpers.js` and the gate's `depcruise` step
 * rejected it. That walk now lives in this module's own
 * `api-keys-http-auth-helpers.ts`, the same per-module-copy precedent as
 * `modules/identity/__tests__/identity-routes-mfa-helpers.ts`), extended
 * with `apiKeys` + `verifyApiKeyDeps` wiring so `routes.integration.test.ts`
 * can exercise BOTH `/v1/api-keys/*` and `/v1/messages` (the
 * `session_or_api_key` policy change) against the same real app.
 */

export const JWT_SECRET = 'api-keys-route-test-secret-at-least-32-chars-long!!';
export const REDUCED_ARGON2 = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
export const STRONG_PASSWORD = 'Correct-Horse-Battery-Staple-9!';

/** A full 5-purpose ring (same shape `webhooks-test-support.ts#makeTenantSecretsRing` establishes) - `api-key-pepper` is what this suite actually exercises. */
function makeApiKeyPepperRing(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-api-keys-route-ring-'));
  const path = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0d).toString('base64');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      active: {
        session: 'k1',
        'tenant-secrets': 'k2',
        'user-secrets': 'k3',
        'optout-pepper': 'k4',
        'api-key-pepper': 'k5',
      },
      keys: {
        k1: { purpose: 'session', material, created_at: '2026-01-01T00:00:00.000Z' },
        k2: { purpose: 'tenant-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k3: { purpose: 'user-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k4: { purpose: 'optout-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
        k5: { purpose: 'api-key-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
      },
    }),
    'utf8',
  );
  return path;
}

const API_KEY_PEPPER_RING_PATH = makeApiKeyPepperRing();

/** Mounted for `optout-pepper` only - `createMessage`'s own dependency. */
export function buildTestKeyProvider(): FileKeyProvider {
  return new FileKeyProvider({
    ringPath: API_KEY_PEPPER_RING_PATH,
    mountedPurposes: ['optout-pepper'],
  });
}

/** Mounted for `api-key-pepper` only - `createApiKey`/`verifyApiKey`'s own dependency. */
export function buildApiKeyPepperProvider(): FileKeyProvider {
  return new FileKeyProvider({
    ringPath: API_KEY_PEPPER_RING_PATH,
    mountedPurposes: ['api-key-pepper'],
  });
}

export function uniqueEmail(label: string): string {
  return `api-keys-${label}-${Math.random().toString(36).slice(2)}@example.test`;
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
    RATE_LIMIT_AUTH_IP_CAPACITY: '500',
    RATE_LIMIT_AUTH_IP_WINDOW_SEC: '900',
    RATE_LIMIT_AUTH_ACCOUNT_CAPACITY: '500',
    RATE_LIMIT_AUTH_ACCOUNT_WINDOW_SEC: '900',
    TRUST_PROXY: 'true',
    ...overrides,
  });
}

export interface BuildApiKeysAppDeps {
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  redis: ReturnType<typeof createRedis>;
  config: Config;
  sentVerificationUrls: Map<string, string>;
  /** Injectable so `a_key_over_its_limit_gets_429_with_retry_after` can drive the limiter deterministically. */
  rateLimiter?: RateLimiter;
}

/** The REAL production app (identity + onboarding + instances + messages + api-keys) - same `buildApp` `roles/api.ts` wires in production. */
export async function buildApiKeysApp(deps: BuildApiKeysAppDeps): Promise<FastifyInstance> {
  const apiKeyPepperProvider = buildApiKeyPepperProvider();
  const apiKeyPepper = apiKeyPepperProvider.getActive('api-key-pepper').material;
  const rateLimiter = deps.rateLimiter ?? createRateLimiter(deps.redis);

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
    verifyApiKeyDeps: {
      pepper: apiKeyPepper,
      lookupByKeyPrefix: (kp) => lookupByKeyPrefix(deps.pool as never, kp),
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
      keyProvider: buildTestKeyProvider(),
      rateLimiter,
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
    apiKeys: { tenantDb: deps.tenantDb, pepper: apiKeyPepper },
    authDeps,
  });
}

export { type SignedUpClient, onboardedMfaClient } from './api-keys-http-auth-helpers.js';

/** Deletes every row `createdUserIds`/`createdClientIds`/`createdPlanIds` created, children-first. Mirrors `enqueue-test-support.ts#cleanupMessagesRecords`, plus `api_keys`. */
export async function cleanupApiKeysRecords(
  pool: ReturnType<typeof createPool>,
  redis: ReturnType<typeof createRedis>,
  createdUserIds: string[],
  createdClientIds: string[],
  createdPlanIds: string[],
): Promise<void> {
  if (createdClientIds.length > 0) {
    await pool.query('DELETE FROM api_keys WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM delivery_event_ids WHERE client_id = ANY($1)', [
      createdClientIds,
    ]);
    await pool.query('DELETE FROM delivery_events WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM message_job_refs WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM recipient_send_buckets WHERE client_id = ANY($1)', [
      createdClientIds,
    ]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [
      createdClientIds,
    ]);
  }
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
    await pool.query('DELETE FROM wallet_ledger_ext_refs WHERE client_id = ANY($1)', [
      createdClientIds,
    ]);
    await pool.query('DELETE FROM wallet_ledger WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM client_pricing WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM memberships WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query(
      `DELETE FROM clients WHERE id = ANY($1)
       -- client_id = id = ANY($1) (clients' tenant_isolation policy keys on "id" - migration 0005)`,
      [createdClientIds],
    );
  }
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  if (createdPlanIds.length > 0) {
    await pool.query('DELETE FROM plan_limits WHERE plan_id = ANY($1)', [createdPlanIds]);
    await pool.query('DELETE FROM plans WHERE id = ANY($1)', [createdPlanIds]);
  }
}

/** Creates one `plans` + `plan_limits` row and assigns it to `clientId`. Mirrors `enqueue-test-support.ts#seedPlanForClient`. */
export async function seedPlanForClient(
  pool: ReturnType<typeof createPool>,
  clientId: string,
): Promise<string> {
  const planId = randomUUID();
  await pool.query('INSERT INTO plans (id, name) VALUES ($1, $2)', [
    planId,
    `Api Keys Test Plan ${planId}`,
  ]);
  await pool.query(
    `INSERT INTO plan_limits (plan_id, max_connected_instances, max_registered_instances)
     VALUES ($1, 5, 5)`,
    [planId],
  );
  await pool.query(
    `UPDATE clients SET plan_id = $1 WHERE id = $2
     -- client_id = id = $2 (clients' tenant_isolation policy keys on "id" - migration 0005)`,
    [planId, clientId],
  );
  return planId;
}

/** Inserts one `whatsapp_instances` row directly (bypassing the P08 link/QR flow). Mirrors `enqueue-test-support.ts#seedInstance`. */
export async function seedInstance(
  pool: ReturnType<typeof createPool>,
  clientId: string,
): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, link_state, health_state)
     VALUES ($1, $2, 'probe', 'linked', 'connected')
     -- client_id = $2`,
    [instanceId, clientId],
  );
  return instanceId;
}
