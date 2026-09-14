import type { Redis } from 'ioredis';
import { jwtVerify } from 'jose';
import type { TenantQueryable } from '@wp/db';
import { sysKey } from '../../platform/redis.js';

/**
 * token-epoch.ts (P04a Unit A5a) - the access-token verification port. Two
 * exports only (canon): `getEpoch` (Redis-cached, Postgres-authoritative
 * `users.token_epoch` read) and `validateAccessToken` (signature + exp via
 * `jose`, then an epoch check against `getEpoch`). The HTTP auth plugin
 * (later unit) is the only planned caller of `validateAccessToken` in
 * production wiring; `session.service.ts` signs tokens but never verifies
 * its own output.
 *
 * Fail-safe (core invariant 2): a Redis MISS is never treated as valid (it
 * always falls through to Postgres, the authority), and a Redis ERROR falls
 * back to the SAME Postgres read - Redis unavailability can only make this
 * slower, never wrong.
 */

export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED';

  constructor(message = 'Invalid or expired session.') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

/**
 * Present ONLY on a staff-minted impersonation token (P28 Unit U3c) -
 * `signImpersonationToken` (identity/impersonation-token.ts) is the ONE
 * writer; `signAccessToken` (session-reuse.ts) never sets this claim, and
 * its own signature is deliberately never widened to carry it (module
 * dispatch, binding).
 */
export interface ImpersonationClaims {
  grantId: string;
  scope: string;
  staffId: string;
}

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  clientId: string;
  role: string;
  epoch: number;
  imp?: ImpersonationClaims;
}

export interface TokenEpochCtx {
  redis: Redis;
  /** Plain connection/pool - `users` carries no client_id/RLS (identity is global), see identity.repo.ts. */
  db: TenantQueryable;
  jwtSecret: string;
  epochCacheTtlSec: number;
  /** Namespacing segment for the cache key (`wp:{env}:epoch:u:{userId}`) - e.g. `NODE_ENV`. */
  env: string;
}

function epochCacheKey(env: string, userId: string): string {
  return sysKey(env, 'epoch', 'u', userId);
}

/**
 * W1 (P04a FIXC): `writeEpochCache`'s plain `SET` is unconditional - two
 * racing post-commit writes (e.g. a `refresh()` reuse-detection sweep and a
 * `logout()` for the same user, landing out of order) could pin the LOWER
 * epoch in the cache for a full TTL, exactly the kind of stale-epoch window
 * `getEpoch`'s own NX fill-guard exists to prevent. Registered once per
 * connection (`ioredis`'s `defineCommand`, same "EVAL once, EVALSHA
 * thereafter" pattern as `platform/http/rate-limit.ts`): sets the key only
 * when it is absent OR the currently-stored number is LOWER than the new
 * value - a `SET` that only ever moves forward.
 */
const WRITE_EPOCH_IF_HIGHER_LUA = `
local current = tonumber(redis.call('GET', KEYS[1]))
local newEpoch = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])
if current == nil or current < newEpoch then
  redis.call('SET', KEYS[1], newEpoch, 'PX', ttlMs)
end
return 1
`;

interface RedisWithEpochWriteCommand extends Redis {
  wpEpochWriteIfHigher?(...args: (string | number)[]): Promise<number>;
}

function epochWriteCommandOf(redis: Redis): RedisWithEpochWriteCommand {
  const client = redis as RedisWithEpochWriteCommand;
  if (typeof client.wpEpochWriteIfHigher !== 'function') {
    redis.defineCommand('wpEpochWriteIfHigher', {
      lua: WRITE_EPOCH_IF_HIGHER_LUA,
      numberOfKeys: 1,
    });
  }
  return client;
}

/**
 * Resolves the CURRENT token epoch for `userId`. A cache hit short-circuits;
 * a MISS or a Redis ERROR both fall through to the same Postgres read (the
 * authority) - the cache is only ever a speed optimization, never a
 * correctness dependency.
 */
export async function getEpoch(ctx: TokenEpochCtx, userId: string): Promise<number> {
  const key = epochCacheKey(ctx.env, userId);

  try {
    const cached = await ctx.redis.get(key);
    if (cached !== null) {
      return Number(cached);
    }
  } catch {
    // Redis error - fall back to Postgres below (fail to the authority, never fail-open).
  }

  const result = await ctx.db.query<{ token_epoch: number }>(
    'SELECT token_epoch FROM users WHERE id = $1',
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    // No such user - never a valid epoch, and never a value worth caching.
    throw new UnauthenticatedError();
  }
  const epoch = Number(row.token_epoch);

  try {
    // FIX 4 (P04a FIXA C1 review): NX - only fill the cache if nothing is
    // there yet. Without NX, a fill that read a STALE (pre-bump) epoch from
    // Postgres can land AFTER `writeEpochCache` has already written the
    // fresh, post-bump value (logout/reuse-detection race) and pin the
    // stale value in the cache for the rest of its TTL. With NX, that same
    // stale fill becomes a no-op whenever the fresh value already won the
    // race to write first - it can never overwrite a newer written value.
    await ctx.redis.set(key, String(epoch), 'EX', ctx.epochCacheTtlSec, 'NX');
  } catch {
    // Cache write failure is non-fatal - Postgres stays the authority either way.
  }

  return epoch;
}

/**
 * Deletes the cached epoch for `userId`. Superseded by `writeEpochCache` for
 * the logout/reuse-detection call sites (FIX 4, P04a FIXA C1 review) - a
 * DEL leaves a window where a concurrent, already-in-flight cache fill
 * (reading the OLD epoch) can land after the delete and re-pin the stale
 * value for a full TTL. Kept for callers that only need "forget this",
 * never "replace with the value I know is now correct".
 */
export async function invalidateEpochCache(
  ctx: Pick<TokenEpochCtx, 'redis' | 'env'>,
  userId: string,
): Promise<void> {
  try {
    await ctx.redis.del(epochCacheKey(ctx.env, userId));
  } catch {
    // Best-effort only - see doc comment above.
  }
}

/**
 * Writes the CURRENT (already-known, e.g. just-bumped) epoch for `userId`
 * straight into the cache with the standard TTL - FIX 4 (P04a FIXA C1
 * review): called AFTER a `token_epoch` bump commits (session.service.ts's
 * `logout` and reuse-detection sweep), never before/inside that
 * transaction. The write is a monotonic Lua CAS (set only when absent or
 * smaller), so two racing post-commit writers can never pin a LOWER epoch
 * over a newer one. Best-effort: a write failure just means the cache
 * self-heals at TTL expiry, Postgres remains authoritative throughout.
 */
export async function writeEpochCache(
  ctx: Pick<TokenEpochCtx, 'redis' | 'env' | 'epochCacheTtlSec'>,
  userId: string,
  epoch: number,
): Promise<void> {
  try {
    // W1 (P04a FIXC): monotonic write (see WRITE_EPOCH_IF_HIGHER_LUA above) -
    // never regresses a higher, already-cached epoch back down, no matter
    // the arrival order of two racing post-commit writes.
    const client = epochWriteCommandOf(ctx.redis);
    await client.wpEpochWriteIfHigher!(
      epochCacheKey(ctx.env, userId),
      epoch,
      ctx.epochCacheTtlSec * 1000,
    );
  } catch {
    // Best-effort only - see doc comment above.
  }
}

/**
 * Verifies signature + expiry (via `jose`), then compares the token's
 * `epoch` claim against the CURRENT epoch (`getEpoch`) - a mismatch (e.g.
 * after logout bumped `token_epoch`) is a typed `UnauthenticatedError`, same
 * as a bad signature or an expired token, so callers never need to
 * distinguish "expired" from "revoked by epoch" (that specificity is a
 * deliberate non-goal - see session.service.ts's own error shape).
 */
export async function validateAccessToken(
  ctx: TokenEpochCtx,
  token: string,
): Promise<AccessTokenClaims> {
  let payload: Record<string, unknown>;
  try {
    const secretKey = new TextEncoder().encode(ctx.jwtSecret);
    const verified = await jwtVerify(token, secretKey, { algorithms: ['HS256'] });
    payload = verified.payload;
  } catch {
    throw new UnauthenticatedError();
  }

  const { sub, sid, clientId, role, epoch, imp } = payload;
  if (
    typeof sub !== 'string' ||
    typeof sid !== 'string' ||
    typeof clientId !== 'string' ||
    typeof role !== 'string' ||
    typeof epoch !== 'number'
  ) {
    throw new UnauthenticatedError();
  }

  const currentEpoch = await getEpoch(ctx, sub);
  if (currentEpoch !== epoch) {
    throw new UnauthenticatedError();
  }

  const parsedImp = parseImpersonationClaim(imp);
  return parsedImp
    ? { sub, sid, clientId, role, epoch, imp: parsedImp }
    : { sub, sid, clientId, role, epoch };
}

/** Structural parse only (never trusted alone - the token's signature is already verified by the caller above). `undefined`/malformed -> `undefined`, never a throw (an ordinary access token simply has no `imp` claim). */
function parseImpersonationClaim(value: unknown): ImpersonationClaims | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { grantId, scope, staffId } = value as Record<string, unknown>;
  if (typeof grantId !== 'string' || typeof scope !== 'string' || typeof staffId !== 'string') {
    return undefined;
  }
  return { grantId, scope, staffId };
}
