import { createHash, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Redis } from 'ioredis';
import type { FastifyReply } from 'fastify';
import type { createPool, TenantDb } from '@wp/db';
import type { ErrorCode } from '@wp/contracts';
import type { Config } from '../../platform/config.js';
import type { RateLimiter } from '../../platform/http/rate-limit.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { sendError } from '../../platform/http/error-mapper.js';
import { sysKey } from '../../platform/redis.js';
import { InvalidVerificationTokenError } from './verify-email.service.js';
import { lockoutDurationMs, type LoginCtx } from './login.service.js';
import { UnauthenticatedError, type SessionCtx } from './session.service.js';
import {
  MfaNotEnrolledError,
  InvalidTotpCodeError,
  InvalidRecoveryCodeError,
  type TotpCtx,
} from './totp.service.js';
import * as identityRepo from './identity.repo.js';

/**
 * routes-shared.ts (P04a FIXD, split out of identity.routes.ts for
 * max-lines) - deps types, error mapping, cookie helpers, ctx builders and
 * the mfa-token/rate-limit-key helpers `auth.routes.ts`/`totp.routes.ts`
 * both need. Pure code motion: no behavior change from the original
 * identity.routes.ts.
 */

export const REFRESH_COOKIE_NAME = 'wp_refresh';
export const REFRESH_COOKIE_PATH = '/v1/auth';

export interface IdentityMailerDeps {
  sendVerificationEmail: (to: string, verifyUrl: string) => Promise<void>;
  sendLockoutEmail: (to: string) => Promise<void>;
  sendReuseDetectedEmail: (to: string) => Promise<void>;
  /** P28 U5 (item 1): the forgot-password flow's own send - see platform/mailer.ts's `Mailer` interface. */
  sendPasswordResetEmail: (to: string, resetUrl: string) => Promise<void>;
}

export interface IdentityRoutesDeps {
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  redis: Redis;
  rateLimiter: RateLimiter;
  config: Config;
  mailer: IdentityMailerDeps;
}

class MappedAppError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'MappedAppError';
    this.code = code;
  }
}

/** Converts a handful of typed service errors whose own `.code` is not an `ErrorCode` into one that is. */
function mapServiceError(err: unknown): unknown {
  if (err instanceof InvalidVerificationTokenError)
    return new MappedAppError('VALIDATION_ERROR', err.message);
  if (err instanceof MfaNotEnrolledError)
    return new MappedAppError('VALIDATION_ERROR', err.message);
  if (err instanceof InvalidTotpCodeError)
    return new MappedAppError('VALIDATION_ERROR', err.message);
  // P04b Unit UB1a, task 2: SAME generic mapping/shape as InvalidTotpCodeError
  // above (both 400 VALIDATION_ERROR) - no oracle distinguishing "wrong TOTP
  // code" from "wrong/already-used recovery code".
  if (err instanceof InvalidRecoveryCodeError)
    return new MappedAppError('VALIDATION_ERROR', err.message);
  if (err instanceof z.ZodError)
    return new MappedAppError('VALIDATION_ERROR', 'Invalid request body.');
  return err;
}

export async function guarded(
  reply: FastifyReply,
  requestId: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    sendError(reply, requestId, mapServiceError(err));
  }
}

export function setRefreshCookie(reply: FastifyReply, token: string, maxAgeDays: number): void {
  reply.setCookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeDays * 24 * 60 * 60,
  });
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}

export function loginCtxFrom(deps: IdentityRoutesDeps): LoginCtx {
  return {
    pool: deps.pool,
    argon2Params: {
      memoryCost: deps.config.ARGON2_MEMORY_KIB,
      timeCost: deps.config.ARGON2_TIME_COST,
      parallelism: deps.config.ARGON2_PARALLELISM,
    },
    lockoutThreshold: deps.config.AUTH_LOCKOUT_THRESHOLD,
    lockoutBaseMinutes: deps.config.AUTH_LOCKOUT_BASE_MINUTES,
    lockoutMaxHours: deps.config.AUTH_LOCKOUT_MAX_HOURS,
    sendLockoutEmail: deps.mailer.sendLockoutEmail,
  };
}

export function sessionCtxFrom(deps: IdentityRoutesDeps): SessionCtx {
  return {
    pool: deps.pool,
    redis: deps.redis,
    jwtSecret: deps.config.AUTH_JWT_SECRET,
    accessTokenTtlMin: deps.config.ACCESS_TOKEN_TTL_MIN,
    refreshTokenTtlDays: deps.config.REFRESH_TOKEN_TTL_DAYS,
    env: deps.config.NODE_ENV,
    // FIXA TODO (P04a FIXA -> resolved here, P04a FIXB): keeps the post-
    // logout/reuse-detection epoch-cache write's TTL from ever drifting from
    // platform/config.ts's own EPOCH_CACHE_TTL_SEC default.
    epochCacheTtlSec: deps.config.EPOCH_CACHE_TTL_SEC,
    sendReuseDetectedEmail: deps.mailer.sendReuseDetectedEmail,
  };
}

/**
 * FIX 10 (P04a FIXB): `db` defaults to `deps.pool`, but `/totp/verify`'s own
 * lockout-ladder transaction passes its OWN open `pg` client so the TOTP
 * code check runs against the SAME transaction as the lockout read/
 * increment - never a second, inconsistent connection.
 */
export function totpCtxFrom(deps: IdentityRoutesDeps, db?: TotpCtx['db']): TotpCtx {
  return {
    db: db ?? deps.pool,
    pool: deps.pool,
    redis: deps.redis,
    keyRingPath: deps.config.KEY_RING_PATH,
    totpWindow: deps.config.TOTP_WINDOW,
    totpUsedCodeTtlSec: deps.config.TOTP_USED_CODE_TTL_SEC,
    env: deps.config.NODE_ENV,
  };
}

export function authDepsFrom(deps: IdentityRoutesDeps): AuthDeps {
  return {
    tokenEpochCtx: {
      redis: deps.redis,
      db: deps.pool,
      jwtSecret: deps.config.AUTH_JWT_SECRET,
      epochCacheTtlSec: deps.config.EPOCH_CACHE_TTL_SEC,
      env: deps.config.NODE_ENV,
    },
    db: deps.pool,
    hasTotpEnrolled: async (userId: string) => {
      const state = await identityRepo.getUserTotpState(deps.pool, userId);
      return Boolean(state?.mfaEnabledAt);
    },
  };
}

/** M20a (P04a FIXB): thin wrapper over the now-promoted `identity.repo.ts` read. */
export async function fetchBasicUser(
  deps: IdentityRoutesDeps,
  userId: string,
): Promise<identityRepo.BasicUser> {
  const row = await identityRepo.fetchBasicUser(deps.pool, userId);
  if (!row) throw new UnauthenticatedError();
  return row;
}

/**
 * FIX 13 (P04a FIXC, CRITICAL): calls `identityRepo.getMeForUser` - the
 * self-scoping (resolve client_id -> set GUC -> `fetchMeRow`, one
 * transaction) wrapper - NEVER `identityRepo.fetchMeRow` directly on the
 * bare pool (that join 401s every real user under `wp_app` + FORCE RLS; see
 * `getMeForUser`'s doc comment in identity.repo.ts).
 */
export async function fetchMeRow(
  deps: IdentityRoutesDeps,
  userId: string,
): Promise<identityRepo.MeRow> {
  const row = await identityRepo.getMeForUser(deps.pool, userId);
  if (!row) throw new UnauthenticatedError();
  return row;
}

// FIX 12 (P04a FIXB): every account-scoped rate-limit key is keyed by
// sha256(lowercased identifier) hex, never the raw email/userId - a Redis
// SCAN of the rate-limit keyspace must never reveal an account's raw
// identifier as a byproduct of throttling it.
export function hashedAccountKey(identifier: string): string {
  return createHash('sha256').update(identifier.toLowerCase(), 'utf8').digest('hex');
}

// FIX 10b (P04a FIXB): namespaces the Redis single-use marker for an mfaToken's `jti`.
function mfaJtiRedisKey(env: string, jti: string): string {
  return sysKey(env, 'mfa', 'jti', jti);
}

/**
 * P04b Unit UB1a (dedup, carried from P04a FIXC S1): re-exports
 * login.service.ts's now-canonical `lockoutDurationMs` under this legacy
 * name - login.service.ts's ladder is the ONE authority; this file no longer
 * keeps its own copy of the formula. The re-export (rather than a rename at
 * every call site) keeps `identity.routes.ts`'s existing
 * `export { totpLockoutDurationMs }` and `lockout-ladder.integration.test.ts`'s
 * import compiling unchanged.
 */
export const totpLockoutDurationMs = lockoutDurationMs;

export async function signMfaToken(deps: IdentityRoutesDeps, userId: string): Promise<string> {
  const secretKey = new TextEncoder().encode(deps.config.AUTH_JWT_SECRET);
  return new SignJWT({ purpose: 'mfa', jti: randomUUID() })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${String(deps.config.MFA_TOKEN_TTL_MIN)}m`)
    .sign(secretKey);
}

interface MfaTokenClaims {
  userId: string;
  jti: string;
  expSec: number;
}

export async function verifyMfaToken(
  deps: IdentityRoutesDeps,
  mfaToken: string,
): Promise<MfaTokenClaims> {
  const secretKey = new TextEncoder().encode(deps.config.AUTH_JWT_SECRET);
  try {
    const { payload } = await jwtVerify(mfaToken, secretKey, { algorithms: ['HS256'] });
    if (
      payload.purpose !== 'mfa' ||
      typeof payload.sub !== 'string' ||
      typeof payload.jti !== 'string' ||
      typeof payload.exp !== 'number'
    ) {
      throw new Error('not an mfa token');
    }
    return { userId: payload.sub, jti: payload.jti, expSec: payload.exp };
  } catch {
    throw new UnauthenticatedError();
  }
}

/**
 * FIX 10b (P04a FIXB): single-use claim on the mfaToken's `jti` - a Redis
 * `SET NX` with TTL = the token's own remaining life. Already-consumed (or a
 * Redis error - fail CLOSED, core invariant 2) both deny the same way: typed
 * `UnauthenticatedError`, never falling open.
 */
export async function claimMfaJtiOrThrow(
  deps: IdentityRoutesDeps,
  jti: string,
  expSec: number,
): Promise<void> {
  const ttlSec = Math.max(1, expSec - Math.floor(Date.now() / 1000));
  let claimed: 'OK' | null;
  try {
    claimed = await deps.redis.set(
      mfaJtiRedisKey(deps.config.NODE_ENV, jti),
      '1',
      'EX',
      ttlSec,
      'NX',
    );
  } catch {
    throw new UnauthenticatedError();
  }
  if (claimed === null) {
    throw new UnauthenticatedError();
  }
}
