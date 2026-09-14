import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl, sysKey } from '../../../platform/redis.js';
import { signup } from '../signup.service.js';
import {
  createSession,
  refresh,
  UnauthenticatedError,
  type SessionCtx,
} from '../session.service.js';
import { findAuthSessionByRefreshTokenHash } from '../identity.repo.js';

/**
 * session-mfa-refresh-race.integration.test.ts (C2 hardening pass, P04b) -
 * the mfa:true carry-forward hook (session-mfa-marker.ts) under the SAME
 * rotation claim-gate race that session.integration.test.ts's
 * `two_concurrent_refreshes_of_the_same_valid_token_...` test already proves
 * for plain sessions, plus a Redis-down fail-closed proof - NOT covered by
 * session-mfa-claim.integration.test.ts (which only exercises a single
 * sequential refresh and a lost-marker scenario, never two concurrent
 * refreshes of an mfa:true session, and never a Redis error mid-refresh).
 */

const JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long!!';
const ENV = 'test';

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

function uniqueEmail(label: string): string {
  return `session-mfa-race-${label}-${randomUUID()}@example.test`;
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
      fullName: `Session Mfa Race Test ${label}`,
      email,
      companyName: `Session Mfa Race Co ${label}`,
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
  redis.disconnect();
  await pool.end();
});

describe('session mfa:true carry-forward - concurrency and Redis failure edges', () => {
  it('two_concurrent_refreshes_of_an_mfa_session_the_winner_still_carries_mfa_true_and_no_revoked_session_id_is_left_marked', async () => {
    const { userId } = await createUser('mfa-concurrent-refresh');
    const first = await createSession(baseSessionCtx(), { userId, mfa: true });
    expect(decodeJwt(first.accessToken).mfa).toBe(true);

    // Same deterministic interleaving barrier as
    // session.integration.test.ts's own concurrent-refresh proof: force
    // BOTH refresh() calls to read the SAME unrevoked session row before
    // either commits its rotation claim.
    let arrivals = 0;
    let releaseFirst: () => void = () => {};
    const firstArrived = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const syncedFind = {
      findAuthSessionByRefreshTokenHash: async (client: TenantQueryable, hash: Buffer) => {
        const row = await findAuthSessionByRefreshTokenHash(client, hash);
        arrivals += 1;
        if (arrivals === 1) {
          await firstArrived;
        } else {
          releaseFirst();
        }
        return row;
      },
    };

    const ctxA = baseSessionCtx({ identityRepo: syncedFind });
    const ctxB = baseSessionCtx({ identityRepo: syncedFind });

    const results = await Promise.allSettled([
      refresh(ctxA, { refreshToken: first.refreshToken }),
      refresh(ctxB, { refreshToken: first.refreshToken }),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof refresh>>> =>
        r.status === 'fulfilled',
    );
    const rejected = results.filter((r) => r.status === 'rejected');

    // Deterministic (barrier-forced), same pattern as the plain-session
    // proof: exactly one winner, exactly one reuse-detected loser.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(UnauthenticatedError);

    // The winner's new access token still carries mfa:true - the carry-
    // forward hook survived the race, not silently dropped.
    const winnerTokens = fulfilled[0]!.value;
    expect(decodeJwt(winnerTokens.accessToken).mfa).toBe(true);

    // Reuse detection revokes the WHOLE chain (both the presented session
    // AND its winning child) - the marker for a revoked session id must
    // never be left present (it would be a stale grant an attacker could
    // exploit if that session id were ever replayed against a marker read).
    const childRows = await pool.query<{ id: string; revoked_at: Date | null }>(
      'SELECT id, revoked_at FROM auth_sessions WHERE parent_session_id = $1',
      [first.sessionId],
    );
    expect(childRows.rows).toHaveLength(1);
    const childSessionId = childRows.rows[0]!.id;
    expect(childRows.rows[0]!.revoked_at).not.toBeNull();

    const revokedChildMarker = await redis.get(sysKey(ENV, 'session', 'mfa', childSessionId));
    expect(revokedChildMarker).toBeNull();

    const revokedParentMarker = await redis.get(sysKey(ENV, 'session', 'mfa', first.sessionId));
    expect(revokedParentMarker).toBeNull();
  });

  it('redis_down_during_refresh_drops_mfa_to_false_but_the_refresh_itself_still_succeeds', async () => {
    const { userId } = await createUser('mfa-redis-down');
    const first = await createSession(baseSessionCtx(), { userId, mfa: true });
    expect(decodeJwt(first.accessToken).mfa).toBe(true);

    const marker = await redis.get(sysKey(ENV, 'session', 'mfa', first.sessionId));
    expect(marker).toBe('1');

    // Simulate Redis being unreachable for the marker read ONLY - a thin
    // wrapper that fails `get` (readMfaMarker's call) but leaves everything
    // else (the real client, used for other calls this test does not make)
    // untouched. readMfaMarker/writeMfaMarker/deleteMfaMarker are private to
    // session-mfa-marker.ts and only reachable via ctx.redis, so failing
    // `get` specifically is how the "Redis down" fault surfaces to refresh().
    const brokenRedis = new Proxy(redis, {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return async () => {
            throw new Error('ECONNREFUSED (simulated Redis outage)');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const ctx = baseSessionCtx({ redis: brokenRedis as typeof redis });
    const second = await refresh(ctx, { refreshToken: first.refreshToken });

    // Fail-closed on the CLAIM (mfa drops to false), NOT on the refresh
    // itself - the rotation still completes and returns usable tokens.
    expect(decodeJwt(second.accessToken).mfa).not.toBe(true);
    expect(second.sessionId).toBeTruthy();
    expect(second.refreshToken).toBeTruthy();

    const sessionRow = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM auth_sessions WHERE id = $1',
      [second.sessionId],
    );
    expect(sessionRow.rows[0]!.revoked_at).toBeNull();
  });
});
