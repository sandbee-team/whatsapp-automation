import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { createPool, TenantDb } from '@wp/db';
import type { createRedis } from '../../../platform/redis.js';
import { loadConfig, type Config } from '../../../platform/config.js';
import { createRateLimiter } from '../../../platform/http/rate-limit.js';
import { registerIdentityRoutes, type IdentityRoutesDeps } from '../identity.routes.js';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { resolveRedisUrl, sysKey } from '../../../platform/redis.js';

/**
 * identity-routes-test-support.ts (P04a FIXD) - shared fixture-building
 * helpers for identity-routes-auth.integration.test.ts and
 * identity-routes-totp.integration.test.ts (split out of the original
 * single identity-routes.integration.test.ts for max-lines). NOT itself a
 * test file (no `.test.ts` suffix - vitest's `include` glob never picks it
 * up). Pure code motion: identical config values/registration calls as the
 * original file.
 */

export const JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long!!';
export const REDUCED_ARGON2 = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
export const STRONG_PASSWORD = 'Correct-Horse-Battery-Staple-9!';

export function uniqueEmail(label: string): string {
  return `identity-routes-${label}-${randomUUID()}@example.test`;
}

export function uniqueIp(): string {
  // A syntactically-plausible, per-test-unique IPv4 so each test's
  // per-IP rate-limit bucket never collides with another test's.
  const n = () => String(1 + Math.floor(Math.random() * 254));
  return `10.${n()}.${n()}.${n()}`;
}

/** Common base fields every identity-routes test config shares; `overrides` wins on conflict. */
export function buildTestConfig(overrides: NodeJS.ProcessEnv): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: resolveDatabaseUrl(),
    REDIS_URL: resolveRedisUrl(),
    AUTH_JWT_SECRET: JWT_SECRET,
    ARGON2_MEMORY_KIB: String(REDUCED_ARGON2.memoryCost),
    ARGON2_TIME_COST: String(REDUCED_ARGON2.timeCost),
    ARGON2_PARALLELISM: String(REDUCED_ARGON2.parallelism),
    ...overrides,
  });
}

export interface BuildAppDeps {
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  redis: ReturnType<typeof createRedis>;
  config: Config;
  mailer?: IdentityRoutesDeps['mailer'];
}

const NOOP_MAILER: IdentityRoutesDeps['mailer'] = {
  sendVerificationEmail: async () => {},
  sendLockoutEmail: async () => {},
  sendReuseDetectedEmail: async () => {},
  sendPasswordResetEmail: async () => {},
};

export interface BuildAppOptions {
  /** Runs right after `cookie` registers, BEFORE `registerIdentityRoutes` - the only point an `onRoute` hook can observe every real auth route as it registers. */
  beforeRegister?: (app: FastifyInstance) => void;
  /** Set `false` to skip the internal `app.ready()` - lets the caller register additional routes (e.g. a `session_mfa`-policy stub) before booting. The caller must then call `app.ready()` itself. Defaults to `true`. */
  ready?: boolean;
}

/** Fastify + cookie + `registerIdentityRoutes` - the SAME registration function `roles/api.ts` wires in production. Ready to `.inject()` unless `options.ready` is `false`. */
export async function buildIdentityApp(
  deps: BuildAppDeps,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: deps.config.TRUST_PROXY as boolean });
  await app.register(cookie);
  options.beforeRegister?.(app);
  const identityDeps: IdentityRoutesDeps = {
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    redis: deps.redis,
    rateLimiter: createRateLimiter(deps.redis),
    config: deps.config,
    mailer: deps.mailer ?? NOOP_MAILER,
  };
  registerIdentityRoutes(app, identityDeps);
  if (options.ready !== false) {
    await app.ready();
  }
  return app;
}

/** Deletes every row `createdUserIds`/`createdClientIds` created, children-first, plus each user's epoch cache key. */
export async function cleanupCreatedIdentityRecords(
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
      await redis.del(sysKey('test', 'epoch', 'u', userId));
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
