import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { createPool, TenantDb } from '@wp/db';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import type { createRedis } from '../../platform/redis.js';
import { loadConfig, type Config } from '../../platform/config.js';
import { createRateLimiter } from '../../platform/http/rate-limit.js';
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

/**
 * enqueue-test-support.ts (P11 Unit U3) - the SAME `buildInstancesApp`-shaped
 * fixture layer as `modules/instances/__tests__/instances-routes-test-
 * support.ts` (an intentional per-module copy, not a cross-module import -
 * `no-deep-module-import` forbids reaching into another module's
 * `__tests__/**` directly), trimmed to what `enqueue.integration.test.ts`
 * needs: app-build config, plan/instance seeding, and cleanup. The signup/
 * verify/MFA/onboarding-walk HTTP helpers live in the
 * `enqueue-http-auth-helpers.ts` sibling (max-lines discipline, same split
 * idiom as `instances.routes-support.ts`). NOT itself a test file (no
 * `.test.ts` suffix) - lives as a sibling of `routes.ts` (not a
 * `__tests__/` subdirectory) per this unit's fixed file scope.
 *
 * `seedInstance` inserts `whatsapp_instances` DIRECTLY (bypassing the P08
 * link/QR flow, which never reaches `health_state='connected'` on its own)
 * so tests can pick an exact `link_state`/`health_state` combination - the
 * same shortcut `modules/queue`'s `claim-test-helpers.ts` takes for its own
 * probe instances.
 */

export const JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long!!';
export const REDUCED_ARGON2 = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
export const STRONG_PASSWORD = 'Correct-Horse-Battery-Staple-9!';

/**
 * Same "distinct kekId per purpose" fixture ring idiom as
 * `optout/registry.integration.test.ts`'s own `makeOptoutPepperRing` (a
 * deliberate per-test-file copy, not a cross-module import -
 * `__tests__/**`/test-support files stay self-contained). `active` MUST
 * list all four `KEK_PURPOSES` (`keyRingSchema`'s `z.record(kekPurposeSchema,
 * z.string())` is exhaustive over the enum, not partial - verified live: a
 * ring with only one `active` entry fails validation with three
 * `active.<purpose>` "expected string, received undefined" issues) even
 * though `mountedPurposes` below only ever loads `optout-pepper` into
 * memory.
 */
function makeOptoutPepperRing(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-enqueue-optout-ring-'));
  const path = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0c).toString('base64');
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

/** One `FileKeyProvider` mounted for `'optout-pepper'` only - the enqueue route's `createMessage` opt-out gate dependency. */
export function buildTestKeyProvider(): FileKeyProvider {
  return new FileKeyProvider({
    ringPath: makeOptoutPepperRing(),
    mountedPurposes: ['optout-pepper'],
  });
}

export function uniqueEmail(label: string): string {
  return `messages-${label}-${randomUUID()}@example.test`;
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

export interface BuildMessagesAppDeps {
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  redis: ReturnType<typeof createRedis>;
  config: Config;
  sentVerificationUrls: Map<string, string>;
}

/** The REAL production app (identity + onboarding + instances + messages) - same `buildApp` roles/api.ts wires in production. */
export async function buildMessagesApp(deps: BuildMessagesAppDeps): Promise<FastifyInstance> {
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
      keyProvider: buildTestKeyProvider(),
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
    // P12 Unit U5: the real production `unresolved` wiring - retry/discard
    // are exercised over real HTTP by `unresolved-api.integration.test.ts`.
    unresolved: { tenantDb: deps.tenantDb, sink: createCountingNoOpRepairedSendSink() },
    authDeps,
  });
}

// The signup/verify/login/MFA/onboarding-walk HTTP fixture helpers
// (`onboardedMfaClient` and its own steps) live in
// enqueue-http-auth-helpers.ts (max-lines discipline) - re-exported here so
// `enqueue.integration.test.ts` needs only one import for both halves.
export { type SignedUpClient, onboardedMfaClient } from './enqueue-http-auth-helpers.js';

/** Creates one `plans` + `plan_limits` row and assigns it to `clientId`. */
export async function seedPlanForClient(
  pool: ReturnType<typeof createPool>,
  clientId: string,
): Promise<string> {
  const planId = randomUUID();
  await pool.query('INSERT INTO plans (id, name) VALUES ($1, $2)', [
    planId,
    `Messages Test Plan ${planId}`,
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

export interface SeedInstanceOptions {
  linkState?: string;
  healthState?: string;
}

/** Inserts one `whatsapp_instances` row directly - see this file's own header comment for why. */
export async function seedInstance(
  pool: ReturnType<typeof createPool>,
  clientId: string,
  options: SeedInstanceOptions = {},
): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, link_state, health_state)
     VALUES ($1, $2, 'probe', $3, $4)
     -- client_id = $2`,
    [instanceId, clientId, options.linkState ?? 'linked', options.healthState ?? 'connected'],
  );
  return instanceId;
}

/** Deletes every row `createdUserIds`/`createdClientIds`/`createdPlanIds` created, children-first. */
export async function cleanupMessagesRecords(
  pool: ReturnType<typeof createPool>,
  redis: ReturnType<typeof createRedis>,
  createdUserIds: string[],
  createdClientIds: string[],
  createdPlanIds: string[],
): Promise<void> {
  if (createdClientIds.length > 0) {
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
