import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl, sysKey } from '../../../platform/redis.js';
import { signup } from '../signup.service.js';
import {
  createSession,
  logout,
  refresh,
  UnauthenticatedError,
  type SessionCtx,
} from '../session.service.js';
import { findAuthSessionByRefreshTokenHash } from '../identity.repo.js';
import { validateAccessToken, type TokenEpochCtx } from '../token-epoch.js';

/**
 * session.integration.test.ts (P04a Unit A5a) - session issuance, rotation,
 * reuse detection and logout, proven against real Postgres + real Redis.
 * Users/clients are created via the existing `signup` service; each test
 * user is unique, so the epoch cache key (`wp:test:epoch:u:{userId}`) never
 * collides across tests without needing an extra prefix. The `mfa:true`
 * claim-hook tests (P04b Unit UB1a) live in the sibling
 * session-mfa-claim.integration.test.ts (split out for max-lines - pure
 * move, same fixtures/helpers duplicated there deliberately, mirroring the
 * identity-routes-*.integration.test.ts split precedent).
 */

const JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long!!';
const ENV = 'test';

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

function uniqueEmail(label: string): string {
  return `session-${label}-${randomUUID()}@example.test`;
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
    { fullName: `Session Test ${label}`, email, companyName: `Session Co ${label}` },
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

describe('session (P04a Unit A5a, session issuance/rotation/logout)', () => {
  it('rotation_happy_path_returns_new_tokens_and_links_the_chain', async () => {
    const { userId } = await createUser('rotation');
    const ctx = baseSessionCtx();

    const first = await createSession(ctx, { userId });
    const second = await refresh(ctx, { refreshToken: first.refreshToken });

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);

    const rows = await pool.query<{
      id: string;
      parent_session_id: string | null;
      revoked_reason: string | null;
    }>('SELECT id, parent_session_id, revoked_reason FROM auth_sessions WHERE id = ANY($1)', [
      [first.sessionId, second.sessionId],
    ]);
    const firstRow = rows.rows.find((r) => r.id === first.sessionId)!;
    const secondRow = rows.rows.find((r) => r.id === second.sessionId)!;
    expect(firstRow.revoked_reason).toBe('rotated');
    expect(secondRow.parent_session_id).toBe(first.sessionId);
  });

  it('reused_refresh_token_revokes_the_whole_chain', async () => {
    const { userId } = await createUser('reuse');
    const ctx = baseSessionCtx();
    const epochCtx = baseEpochCtx();

    const session0 = await createSession(ctx, { userId });
    const session1 = await refresh(ctx, { refreshToken: session0.refreshToken });
    const session2 = await refresh(ctx, { refreshToken: session1.refreshToken });

    // FIX 3 (P04a FIXA C1 review): the pre-theft access token (issued for
    // session2, before reuse is ever detected) must still validate right up
    // until the reuse sweep runs.
    await expect(validateAccessToken(epochCtx, session2.accessToken)).resolves.toMatchObject({
      sub: userId,
    });

    // Present the FIRST (already-rotated) refresh token again - a theft signal.
    await expect(refresh(ctx, { refreshToken: session0.refreshToken })).rejects.toThrow(
      UnauthenticatedError,
    );

    const chainRows = await pool.query<{
      id: string;
      revoked_at: Date | null;
      revoked_reason: string | null;
    }>('SELECT id, revoked_at, revoked_reason FROM auth_sessions WHERE id = ANY($1)', [
      [session0.sessionId, session1.sessionId, session2.sessionId],
    ]);
    expect(chainRows.rows).toHaveLength(3);
    for (const row of chainRows.rows) {
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_reason).not.toBeNull();
    }

    const auditRows = await pool.query(
      "SELECT id FROM audit_logs WHERE target_id = $1 AND action = 'auth.refresh_reuse_detected'",
      [userId],
    );
    expect(auditRows.rows).toHaveLength(1);

    // FIX 3 (P04a FIXA C1 review): reuse detection must kill access tokens
    // NOW, not just at their own 15-minute expiry - the SAME pre-theft
    // access token that validated above must now be rejected, because the
    // reuse sweep bumped `users.token_epoch` in the same transaction as the
    // chain revoke.
    await expect(validateAccessToken(epochCtx, session2.accessToken)).rejects.toThrow(
      UnauthenticatedError,
    );

    // The previously-valid newest token is now revoked too - its next refresh is rejected.
    await expect(refresh(ctx, { refreshToken: session2.refreshToken })).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  // FIX 2 (P04a FIXA C1 review, lost-update race) - fixed: `refresh()` now
  // claims the presented session via the conditional `revokeAuthSession`
  // UPDATE (`WHERE revoked_at IS NULL`) BEFORE inserting a child session -
  // only the caller that actually claims 1 row proceeds; a 0-row claim is
  // treated exactly as reuse detection (whole-chain revoke + audit + typed
  // 401), never a second child session.
  it('two_concurrent_refreshes_of_the_same_valid_token_produce_at_most_one_new_session', async () => {
    // Both refresh() calls read the SAME unrevoked session row before
    // either commits its rotation - a synchronization barrier on the
    // injected identityRepo.findAuthSessionByRefreshTokenHash forces the
    // genuine interleaving deterministically (no sleeps, no timing luck):
    // both SELECTs land, THEN both proceed to write.
    const { userId } = await createUser('concurrent-refresh');
    const session0 = await createSession(baseSessionCtx(), { userId });

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
      refresh(ctxA, { refreshToken: session0.refreshToken }),
      refresh(ctxB, { refreshToken: session0.refreshToken }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    const childRows = await pool.query<{ id: string }>(
      'SELECT id FROM auth_sessions WHERE parent_session_id = $1',
      [session0.sessionId],
    );
    // W3 (P04a FIXC): the barrier above forces BOTH calls to reach the
    // conditional-UPDATE claim gate before either commits, so this is
    // deterministic (not merely "at most one") - the winner's refresh()
    // resolves, the loser is treated exactly as reuse detection (typed
    // rejection), never both failing and never both succeeding. `<= 1` would
    // silently pass a both-fail regression too; this is the queue-engineering
    // skill's "exactly-one-worker" claim pattern, applied to session rotation.
    expect(childRows.rows.length).toBe(1);
    expect(fulfilled.length).toBe(1);
  });

  it('logout_bumps_token_epoch_and_the_old_access_token_is_rejected', async () => {
    const { userId } = await createUser('logout');
    const ctx = baseSessionCtx();
    const epochCtx = baseEpochCtx();

    const session = await createSession(ctx, { userId });
    await expect(validateAccessToken(epochCtx, session.accessToken)).resolves.toMatchObject({
      sub: userId,
    });

    await logout(ctx, { sessionId: session.sessionId });

    // FIX 4 (P04a FIXA C1 review): logout WRITES the new epoch into the
    // cache post-commit (never DEL) - assert the cache directly holds the
    // bumped value, not just "missing".
    const cached = await redis.get(sysKey(ENV, 'epoch', 'u', userId));
    expect(cached).not.toBeNull();
    expect(Number(cached)).toBe(1);

    await expect(validateAccessToken(epochCtx, session.accessToken)).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('a_token_epoch_cache_miss_reads_postgres_instead_of_accepting_the_token', async () => {
    const { userId } = await createUser('cache-miss');
    const ctx = baseSessionCtx();
    const epochCtx = baseEpochCtx();

    const session = await createSession(ctx, { userId });
    await logout(ctx, { sessionId: session.sessionId });

    // Force a miss regardless of whether logout's own cache invalidation ran.
    await redis.del(sysKey(ENV, 'epoch', 'u', userId));

    await expect(validateAccessToken(epochCtx, session.accessToken)).rejects.toThrow(
      UnauthenticatedError,
    );
  });
});
