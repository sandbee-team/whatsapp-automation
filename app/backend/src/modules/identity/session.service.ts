import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { TenantQueryable } from '@wp/db';
import * as identityRepoDefault from './identity.repo.js';
import { UnauthenticatedError } from './token-epoch.js';
import { writeMfaMarker, readMfaMarker, deleteMfaMarker } from './session-mfa-marker.js';
import { safeRollback, flushEpochCacheAfterCommit } from './session-internal.js';
import {
  resolveMembershipOrThrow,
  revokeChainAsReuseDetected,
  refreshTokenHashOf,
  signAccessToken,
} from './session-reuse.js';
import { logout, type LogoutInput } from './session-logout.js';

/**
 * session.service.ts (P04a Unit A5a) - session issuance/rotation.
 * `auth_sessions`/`users` carry no `client_id`/RLS, so this runs its OWN
 * BEGIN/COMMIT/ROLLBACK against a plain pool connection, like
 * login.service.ts. Membership resolution + the reuse-detection sweep/chain
 * revocation live in session-reuse.ts (P04a FIXD split); `logout()` lives in
 * session-logout.ts, the two tiny shared transaction helpers in
 * session-internal.ts, and the `mfa:true` claim's Redis marker in
 * session-mfa-marker.ts (all P04b Unit UB1a splits, re-exported below so
 * every existing caller keeps importing from this one file).
 *
 * Canon: access token = 15-min JWT (HS256), clientId/role ALWAYS
 * re-resolved from `memberships`, never trusted from caller input. Refresh
 * token = 32 random bytes hex-encoded; only its SHA-256 is stored. Rotation
 * inserts a NEW row (`parent_session_id` = presented session) and revokes
 * the presented row. Reuse detection (an already-revoked presented token)
 * revokes the WHOLE chain, audits it, and emails the user AFTER commit
 * (mail failure logged, never thrown) - then returns `UnauthenticatedError`.
 * Logout revokes the session AND bumps `users.token_epoch` in ONE
 * transaction; the Redis epoch cache is invalidated AFTER commit only.
 */

export { UnauthenticatedError };
export { logout, type LogoutInput };

export interface SessionDbClient extends TenantQueryable {
  release(err?: unknown): void;
}

export interface SessionDbPool {
  connect(): Promise<SessionDbClient>;
}

type IdentityRepo = typeof identityRepoDefault;

export interface SessionCtx {
  pool: SessionDbPool;
  redis: Redis;
  jwtSecret: string;
  accessTokenTtlMin: number;
  refreshTokenTtlDays: number;
  /** Namespacing segment for the epoch cache key - see token-epoch.ts. */
  env: string;
  /** TTL for the post-logout/reuse-detection `writeEpochCache` call - defaults to `DEFAULT_EPOCH_CACHE_TTL_SEC` below (matches platform/config.ts's `EPOCH_CACHE_TTL_SEC` default). */
  epochCacheTtlSec?: number;
  /** Mailer port - called AFTER commit only; a failure here is logged, never thrown. */
  sendReuseDetectedEmail: (to: string) => Promise<void>;
  now?: () => Date;
  generateId?: () => string;
  generateRefreshToken?: () => Buffer;
  /** Test-double injection point - never used in production wiring. */
  identityRepo?: Partial<IdentityRepo>;
}

export interface CreateSessionInput {
  userId: string;
  /**
   * P04b Unit UB1a: set `true` only right after a TOTP/recovery-code
   * verification - the resulting access token carries the `mfa: true`
   * claim, and a best-effort Redis marker is written (AFTER commit) so a
   * later `refresh()` of THIS session can carry the claim forward. A
   * marker-write failure is logged and never thrown (fail-safe: worst case
   * is the user re-does TOTP on the next refresh, never a false MFA grant).
   */
  mfa?: boolean;
}

export interface SessionTokens {
  sessionId: string;
  accessToken: string;
  /** Raw refresh token, hex-encoded - returned ONCE; only its hash is stored. */
  refreshToken: string;
}

export interface RefreshInput {
  /** Raw refresh token, hex-encoded (as returned by `createSession`/`refresh`). */
  refreshToken: string;
}

/** Issues the FIRST session (no parent) for an already-authenticated `userId` - e.g. right after `login()`/`signup()`. */
export async function createSession(
  ctx: SessionCtx,
  input: CreateSessionInput,
): Promise<SessionTokens> {
  const identityRepo: IdentityRepo = { ...identityRepoDefault, ...ctx.identityRepo };
  const now = ctx.now ?? (() => new Date());
  const generateId = ctx.generateId ?? randomUUID;
  const generateRefreshToken = ctx.generateRefreshToken ?? (() => randomBytes(32));

  const sessionId = generateId();
  const rawRefreshToken = generateRefreshToken();
  const refreshToken = rawRefreshToken.toString('hex');
  const refreshTokenHash = createHash('sha256').update(rawRefreshToken).digest();
  const issuedAt = now();
  const expiresAt = new Date(issuedAt.getTime() + ctx.refreshTokenTtlDays * 24 * 60 * 60 * 1000);

  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    const { clientId, role } = await resolveMembershipOrThrow(identityRepo, client, input.userId);
    const epoch = await identityRepo.getUserTokenEpoch(client, input.userId);
    await identityRepo.insertAuthSession(client, {
      id: sessionId,
      userId: input.userId,
      refreshTokenHash,
      parentSessionId: null,
      issuedAt,
      expiresAt,
    });
    await client.query('COMMIT');

    if (input.mfa) {
      await writeMfaMarker(ctx, sessionId);
    }

    const accessToken = await signAccessToken(
      ctx,
      { userId: input.userId, sessionId, clientId, role, epoch, mfa: input.mfa },
      issuedAt,
    );
    return { sessionId, accessToken, refreshToken };
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Rotates a refresh token. On reuse (the presented token's row is already
 * revoked, for ANY reason) this revokes the whole chain, audits it, and
 * schedules the user notification - see the module doc comment.
 */
export async function refresh(ctx: SessionCtx, input: RefreshInput): Promise<SessionTokens> {
  const identityRepo: IdentityRepo = { ...identityRepoDefault, ...ctx.identityRepo };
  const now = ctx.now ?? (() => new Date());
  const generateId = ctx.generateId ?? randomUUID;
  const generateRefreshToken = ctx.generateRefreshToken ?? (() => randomBytes(32));

  const presentedHash = refreshTokenHashOf(input.refreshToken);
  const client = await ctx.pool.connect();
  let reuseNotifyEmail: string | null = null;
  let epochToCache: { userId: string; epoch: number } | null = null;
  let revokedSessionIdsToUnmark: string[] | null = null;

  // Theft signal (canon): revoke the ENTIRE chain, both directions, audit
  // it, and commit - then set the outer post-commit state and throw. Shared
  // by both reuse triggers below (an already-revoked presented token, and
  // the lost-update-race loser of a concurrent rotation).
  const commitReuseDetectedAndThrow = async (sessionId: string, userId: string): Promise<never> => {
    const { email, newEpoch, revokedSessionIds } = await revokeChainAsReuseDetected(
      identityRepo,
      client,
      sessionId,
      userId,
      now(),
    );
    await client.query('COMMIT');
    reuseNotifyEmail = email;
    epochToCache = { userId, epoch: newEpoch };
    revokedSessionIdsToUnmark = revokedSessionIds;
    throw new UnauthenticatedError();
  };

  try {
    await client.query('BEGIN');
    const session = await identityRepo.findAuthSessionByRefreshTokenHash(client, presentedHash);
    if (!session) {
      await client.query('ROLLBACK');
      throw new UnauthenticatedError();
    }

    if (session.revokedAt) {
      await commitReuseDetectedAndThrow(session.id, session.userId);
    }

    if (session.expiresAt.getTime() <= now().getTime()) {
      await client.query('ROLLBACK');
      throw new UnauthenticatedError();
    }

    const issuedAt = now();

    // FIX 2 (P04a FIXA C1 review, lost-update race): the REVOKE is the
    // rotation CLAIM GATE - exactly one of two concurrent `refresh()` calls
    // presenting the SAME valid token can claim it; the loser (0 rows) is
    // treated EXACTLY as reuse detection and never inserts a child session.
    const claimed = await identityRepo.revokeAuthSession(client, session.id, 'rotated', issuedAt);
    if (!claimed) {
      await commitReuseDetectedAndThrow(session.id, session.userId);
    }

    const newSessionId = generateId();
    const rawRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = createHash('sha256').update(rawRefreshToken).digest();
    const expiresAt = new Date(issuedAt.getTime() + ctx.refreshTokenTtlDays * 24 * 60 * 60 * 1000);

    await identityRepo.insertAuthSession(client, {
      id: newSessionId,
      userId: session.userId,
      refreshTokenHash: newRefreshTokenHash,
      parentSessionId: session.id,
      issuedAt,
      expiresAt,
    });
    const { clientId, role } = await resolveMembershipOrThrow(identityRepo, client, session.userId);
    const epoch = await identityRepo.getUserTokenEpoch(client, session.userId);
    await client.query('COMMIT');

    // P04b Unit UB1a: carry the `mfa` claim forward ONLY when the OLD
    // session's marker is still present - fail CLOSED (never fall open) on a
    // Redis miss or error (readMfaMarker resolves `false` either way).
    const carriedMfa = await readMfaMarker(ctx, session.id);
    if (carriedMfa) {
      await writeMfaMarker(ctx, newSessionId);
      await deleteMfaMarker(ctx, session.id);
    }

    const accessToken = await signAccessToken(
      ctx,
      { userId: session.userId, sessionId: newSessionId, clientId, role, epoch, mfa: carriedMfa },
      issuedAt,
    );
    return { sessionId: newSessionId, accessToken, refreshToken: rawRefreshToken.toString('hex') };
  } catch (err) {
    if (!(err instanceof UnauthenticatedError)) {
      await safeRollback(client);
    }
    throw err;
  } finally {
    client.release();
    if (reuseNotifyEmail) {
      try {
        await ctx.sendReuseDetectedEmail(reuseNotifyEmail);
      } catch (mailErr) {
        // S2 (P04a FIXC): SMTP errors can embed the recipient address (PII) -
        // log only { name, code }, matching error-mapper.ts's own redaction
        // style, never `.message`.
        console.error('refresh: failed to send reuse-detected notification email (non-fatal):', {
          name: mailErr instanceof Error ? mailErr.name : 'Error',
          code: (mailErr as { code?: unknown } | null)?.code,
        });
      }
    }
    await flushEpochCacheAfterCommit(ctx, epochToCache);
    // P04b FIXF (C2 bug 2): the epoch bump above already invalidates every
    // token from the revoked chain - this is best-effort hygiene, not the
    // safety mechanism, so a Redis failure inside deleteMfaMarker is logged
    // and never thrown (see session-mfa-marker.ts's doc comment). No-op
    // (empty array) on the non-reuse-detected path.
    for (const revokedSessionId of revokedSessionIdsToUnmark ?? []) {
      await deleteMfaMarker(ctx, revokedSessionId);
    }
  }
}
