import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { createPool, TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { buildApp } from '../../../platform/http/server.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import {
  failClosedInstanceOwnership,
  createRealtimeHub,
  type RealtimeCtx,
} from '../../realtime/index.js';
import { createCountingNoOpRepairedSendSink } from '../../queue/index.js';
import type { InternalRoutesDeps } from '../internal-routes-deps.js';
import { buildServiceTokenHeader } from '../service-token.js';
import type { StaffRole } from '@wp/domain';

/**
 * internal-routes-test-support.ts (P19 Unit U5, step 8; P28 Unit U3a, step 4
 * rewrite) - per-module fixture fork (see `wallet-routes-test-support.ts`'s
 * own doc: "an intentional per-module copy, not a cross-module import" -
 * no-deep-module-import forbids reaching into a sibling's `__tests__/**`).
 * The `/internal/v1` surface needs no tenant session at all, so this
 * fixture skips the identity/onboarding HTTP walk entirely. NOT itself a
 * test file.
 */

/** Never exercised by this fixture (`/v1/messages` is out of scope). */
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

/** A minimal `AuthDeps` - never exercised (every registered non-internal route group here goes unused by this fixture's own tests, but `buildApp` still requires a shared `authDeps`). */
function stubAuthDeps(pool: ReturnType<typeof createPool>): AuthDeps {
  return {
    tokenEpochCtx: {
      redis: undefined as never,
      db: pool,
      jwtSecret: 'x'.repeat(32),
      epochCacheTtlSec: 3600,
      env: 'test',
    },
    db: pool,
    hasTotpEnrolled: async () => false,
  };
}

export interface BuildInternalAppDeps {
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  /** Undefined simulates `INTERNAL_API_ENABLED=false` - `buildApp`'s own optional-dep gate then never registers the module at all (404, not 403). */
  internal: InternalRoutesDeps | undefined;
}

/** The REAL production app, with `internal` wired for real and every other route group stubbed to the minimal "not exercised" shape - same idiom as `wallet-routes-test-support.ts#buildWalletApp`. */
export async function buildInternalApp(deps: BuildInternalAppDeps): Promise<FastifyInstance> {
  const authDeps = stubAuthDeps(deps.pool);

  return buildApp({
    identity: {
      pool: deps.pool,
      tenantDb: deps.tenantDb,
      redis: undefined as never,
      rateLimiter: undefined as never,
      config: { TRUST_PROXY: true } as never,
      mailer: {
        sendVerificationEmail: async () => {},
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
    internal: deps.internal,
    authDeps,
  });
}

/** Builds the `X-WP-Internal-Token` header for `method`/`path`, signed `now`. */
export function internalTokenHeader(
  secret: string,
  method: string,
  path: string,
  now: Date = new Date(),
): string {
  return buildServiceTokenHeader(secret, method, path, Math.floor(now.getTime() / 1000));
}

/** Seeds one `staff_users` probe row for `role`, returning its id. Caller owns cleanup via `cleanupStaffUsers`. */
export async function seedStaffUser(
  pool: ReturnType<typeof createPool>,
  role: StaffRole,
  options: { status?: 'active' | 'disabled' } = {},
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO staff_users (id, email, full_name, password_hash, role, status, mfa_enabled_at)
     VALUES ($1, $2, 'Probe Staff', 'x', $3, $4, now())`,
    [id, `staff-probe-${id}@example.test`, role, options.status ?? 'active'],
  );
  return id;
}

export async function cleanupStaffUsers(
  pool: ReturnType<typeof createPool>,
  staffIds: string[],
): Promise<void> {
  if (staffIds.length === 0) return;
  await pool.query('DELETE FROM staff_audit_log WHERE staff_id = ANY($1)', [staffIds]);
  await pool.query('DELETE FROM staff_users WHERE id = ANY($1)', [staffIds]);
}

/** Curried on `secret` (each test file's own service-token secret) - returns `staffHeaders(method, path, staffId, extra?)` building `x-wp-internal-token`, `x-actor: staff:<id>`, `idempotency-key`. */
export function makeStaffHeaders(
  secret: string,
): (
  method: string,
  path: string,
  staffId: string,
  extra?: Record<string, string>,
) => Record<string, string> {
  return (method, path, staffId, extra = {}) => ({
    'x-wp-internal-token': internalTokenHeader(secret, method, path),
    'x-actor': `staff:${staffId}`,
    'idempotency-key': randomUUID(),
    ...extra,
  });
}
