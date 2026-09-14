import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl, sysKey } from '../../../platform/redis.js';
import { signup } from '../signup.service.js';
import { createSession, refresh, type SessionCtx } from '../session.service.js';
import type { TokenEpochCtx } from '../token-epoch.js';
import { MfaRequiredError, registerRoute } from '../../../platform/http/route-policy.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';

/**
 * session-mfa-claim.integration.test.ts (P04b Unit UB1a, task 1; split out
 * of session.integration.test.ts for max-lines) - the `mfa:true` claim hook:
 * a session minted right after a TOTP/recovery-code verification carries
 * `mfa: true` on its access token, that claim SURVIVES rotation (the Redis
 * marker is read off the OLD session and copied onto the NEW one), and a
 * lost marker fails CLOSED (never falls open into a false MFA grant). Own
 * fixtures (independent of the sibling session.integration.test.ts's
 * fixtures), mirroring the identity-routes-*.integration.test.ts split
 * precedent.
 */

const JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long!!';
const ENV = 'test';

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

function uniqueEmail(label: string): string {
  return `session-mfa-claim-${label}-${randomUUID()}@example.test`;
}

function baseSessionCtx(overrides: Partial<SessionCtx> = {}): SessionCtx {
  return {
    pool,
    redis,
    jwtSecret: JWT_SECRET,
    accessTokenTtlMin: 15,
    refreshTokenTtlDays: 30,
    env: ENV,
    sendReuseDetectedEmail: async () => {},
    ...overrides,
  };
}

function baseEpochCtx(overrides: Partial<TokenEpochCtx> = {}): TokenEpochCtx {
  return {
    redis,
    db: pool,
    jwtSecret: JWT_SECRET,
    epochCacheTtlSec: 3600,
    env: ENV,
    ...overrides,
  };
}

async function createUser(label: string): Promise<{ userId: string; clientId: string }> {
  const email = uniqueEmail(label);
  const result = await signup(
    {
      tenantDb,
      sendVerificationEmail: async () => {},
      publicBaseUrl: 'http://localhost:5173',
      signupCreditMinor: 10000,
      lowBalanceThresholdMinor: 500,
    },
    {
      fullName: `Session Mfa Claim Test ${label}`,
      email,
      companyName: `Session Mfa Claim Co ${label}`,
    },
  );
  createdUserIds.push(result.userId);
  createdClientIds.push(result.clientId);
  return { userId: result.userId, clientId: result.clientId };
}

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM auth_sessions WHERE user_id = ANY($1)', [createdUserIds]);
    await pool.query('DELETE FROM email_verification_tokens WHERE user_id = ANY($1)', [
      createdUserIds,
    ]);
    for (const userId of createdUserIds) {
      await redis.del(sysKey(ENV, 'epoch', 'u', userId));
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
  redis.disconnect();
  await pool.end();
});

describe('session mfa:true claim hook (P04b Unit UB1a, task 1)', () => {
  it('a_session_created_after_totp_carries_mfa_true_and_survives_refresh', async () => {
    const { userId } = await createUser('mfa-claim');
    const ctx = baseSessionCtx();

    const first = await createSession(ctx, { userId, mfa: true });
    expect(decodeJwt(first.accessToken).mfa).toBe(true);

    const marker = await redis.get(sysKey(ENV, 'session', 'mfa', first.sessionId));
    expect(marker).toBe('1');

    const second = await refresh(ctx, { refreshToken: first.refreshToken });
    expect(decodeJwt(second.accessToken).mfa).toBe(true);

    const newMarker = await redis.get(sysKey(ENV, 'session', 'mfa', second.sessionId));
    expect(newMarker).toBe('1');
  });

  it('mfa_claim_is_dropped_fail_closed_when_redis_loses_the_marker', async () => {
    const { userId } = await createUser('mfa-claim-lost');
    const ctx = baseSessionCtx();

    const first = await createSession(ctx, { userId, mfa: true });
    expect(decodeJwt(first.accessToken).mfa).toBe(true);

    // Simulate the marker being lost (TTL expiry / eviction) before refresh.
    await redis.del(sysKey(ENV, 'session', 'mfa', first.sessionId));

    const second = await refresh(ctx, { refreshToken: first.refreshToken });
    expect(decodeJwt(second.accessToken).mfa).not.toBe(true);

    // A session_mfa-policy route now denies MFA_REQUIRED for this
    // TOTP-enrolled user (the rotated token no longer carries mfa:true).
    const app = Fastify();
    const authDeps: AuthDeps = {
      tokenEpochCtx: baseEpochCtx(),
      db: pool,
      hasTotpEnrolled: async () => true,
    };
    registerRoute(app, authDeps, {
      method: 'GET',
      path: '/probe',
      policy: 'session_mfa',
      scope: 'test:probe',
      handler: (_req, reply) => {
        reply.send({ ok: true });
      },
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/probe',
        headers: { authorization: `Bearer ${second.accessToken}` },
      });
      expect(response.statusCode).toBe(401);
      const body = response.json() as { error: { code: string } };
      expect(body.error.code).toBe(new MfaRequiredError().code);
    } finally {
      await app.close();
    }
  });
});
