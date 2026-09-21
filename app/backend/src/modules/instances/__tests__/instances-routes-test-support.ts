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
import { publishWake } from '../../../engine/queue/wake.js';
import { publishDiscoveryWake } from '../../../engine/fleet/discovery-wake.js';

/**
 * instances-routes-test-support.ts (P08 Unit U6c) - the SAME
 * `buildTenancyApp`-shaped fixture layer as
 * `modules/tenancy/__tests__/tenancy-routes-test-support.ts` (an intentional
 * per-module copy, not a cross-module import - `no-deep-module-import`
 * forbids a test file under `modules/instances/__tests__/` from reaching
 * into `modules/tenancy/__tests__/**` directly), extended with the
 * onboarding-walk + plan-seeding helpers the instance link/park route tests
 * need. NOT itself a test file (no `.test.ts` suffix).
 */

export const JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long!!';
export const REDUCED_ARGON2 = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
export const STRONG_PASSWORD = 'Correct-Horse-Battery-Staple-9!';

export function uniqueEmail(label: string): string {
  return `instances-${label}-${randomUUID()}@example.test`;
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

export interface BuildInstancesAppDeps {
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  redis: ReturnType<typeof createRedis>;
  config: Config;
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
export async function buildInstancesApp(deps: BuildInstancesAppDeps): Promise<FastifyInstance> {
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
    // `publishDiscoveryWake` bound to the real `deps.redis` handle (2026-09-17
    // fix) - `link-discovery-wake.integration.test.ts` subscribes to the real
    // fleet-wide channel this publishes on, same idiom `resume` below already
    // established for its own (per-instance) wake.
    instances: {
      entitlementCtx: { pool: deps.pool },
      tenantDb: deps.tenantDb,
      publishDiscoveryWake: () => publishDiscoveryWake(deps.redis, deps.config.NODE_ENV),
    },
    // P16 Unit D (step 8): the real resume route, bound to the real
    // `deps.redis` handle - `resume_publishes_a_wake_and_writes_actor_user_id`
    // subscribes to the real channel `publishWake` publishes on.
    resume: {
      tenantDb: deps.tenantDb,
      publishWake: (clientId, instanceId) =>
        publishWake(deps.redis, deps.config.NODE_ENV, clientId, instanceId),
    },
    // P11 Unit U3: `BuildAppDeps` grew a required `messages` field -
    // this fixture never exercises `/v1/messages` itself, so the same
    // `entitlementCtx` shape `instances` above already uses is enough.
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
    // P12 Unit U5: `BuildAppDeps` grew a required `unresolved` field - this
    // fixture never exercises the retry/discard routes, so a fresh counting
    // no-op sink is enough (same "not exercised, minimal shape" precedent as
    // `messages`/`realtime` above).
    unresolved: { tenantDb: deps.tenantDb, sink: createCountingNoOpRepairedSendSink() },
    authDeps,
  });
}

// The signup/verify/login/MFA/onboarding-walk HTTP fixture helpers
// (`onboardedMfaClient` and its own steps) live in
// instances-http-auth-helpers.ts (max-lines discipline) - re-exported here
// so every existing `from './instances-routes-test-support.js'` import
// keeps working unchanged.
export {
  type SignedUpClient,
  signupClientViaHttp,
  verifyClientEmailViaHttp,
  loginViaHttp,
  mintMfaAccessTokenViaHttp,
  walkOnboardingToConnectWhatsapp,
  onboardedMfaClient,
} from './instances-http-auth-helpers.js';

/** Creates one `plans` + `plan_limits` row and assigns it to `clientId` - the registered/connected instance caps every create/online route test needs. */
export async function seedPlanForClient(
  pool: ReturnType<typeof createPool>,
  clientId: string,
  limits: { maxRegisteredInstances: number; maxConnectedInstances: number },
): Promise<string> {
  const planId = randomUUID();
  await pool.query('INSERT INTO plans (id, name) VALUES ($1, $2)', [
    planId,
    `Instances Test Plan ${planId}`,
  ]);
  await pool.query(
    `INSERT INTO plan_limits (plan_id, max_connected_instances, max_registered_instances)
     VALUES ($1, $2, $3)`,
    [planId, limits.maxConnectedInstances, limits.maxRegisteredInstances],
  );
  await pool.query('UPDATE clients SET plan_id = $1 WHERE id = $2', [planId, clientId]);
  return planId;
}

/** Deletes every row `createdUserIds`/`createdClientIds`/`createdPlanIds` created, children-first. */
export async function cleanupInstancesRecords(
  pool: ReturnType<typeof createPool>,
  redis: ReturnType<typeof createRedis>,
  createdUserIds: string[],
  createdClientIds: string[],
  createdPlanIds: string[] = [],
): Promise<void> {
  if (createdClientIds.length > 0) {
    await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [createdClientIds]);
    // P16: resume.ts (and other instance-lifecycle writes) emit outbox rows
    // (e.g. instance.resumed) for these clients - never deleted here before,
    // so a crash-safety-shaped orphan (unpublished, client already gone)
    // sat permanently in the shared dev DB and was silently claimed by
    // relay.integration.test.ts's cross-tenant `claim-outbox` on ITS second
    // tick, one file later (see roles/relay.integration.test.ts's own
    // note on this class of leak).
    await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [createdClientIds]);
    // P13: instances.routes.ts's POST /v1/instances now also provisions an
    // instance_pacing_state row per created instance - must be deleted
    // before whatsapp_instances (FK: instance_pacing_state_instance_id_fkey).
    await pool.query('DELETE FROM instance_pacing_state WHERE client_id = ANY($1)', [
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
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [createdClientIds]);
  }
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  if (createdPlanIds.length > 0) {
    await pool.query('DELETE FROM plan_limits WHERE plan_id = ANY($1)', [createdPlanIds]);
    await pool.query('DELETE FROM plans WHERE id = ANY($1)', [createdPlanIds]);
  }
}
