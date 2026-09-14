import type { Redis } from 'ioredis';
import { sysKey } from '../../platform/redis.js';

/**
 * session-mfa-marker.ts (P04b Unit UB1a, split out of session.service.ts for
 * max-lines) - the Redis marker recording that a session was minted right
 * after a TOTP/recovery-code verification (`mfa: true`), which
 * `session.service.ts`'s `refresh()` reads to carry the claim forward across
 * rotation. Fail-CLOSED throughout (core invariant 2): a marker write
 * failure is logged and never thrown, and a marker READ failure or a plain
 * miss both resolve to `false` (the rotated token just drops the `mfa`
 * claim - the user re-does TOTP - never a false MFA grant).
 */

interface MfaMarkerCtx {
  redis: Redis;
  env: string;
}

/** Namespaces the Redis marker key for `sessionId`. */
function mfaMarkerKey(env: string, sessionId: string): string {
  return sysKey(env, 'session', 'mfa', sessionId);
}

/**
 * Best-effort marker write (AFTER commit only, called by
 * `session.service.ts`) - a failure here is logged ({name, code} only, no
 * PII) and never thrown (core invariant: never let a non-durable side-effect
 * undo already-committed session issuance).
 */
export async function writeMfaMarker(
  ctx: MfaMarkerCtx & { refreshTokenTtlDays: number },
  sessionId: string,
): Promise<void> {
  try {
    await ctx.redis.set(
      mfaMarkerKey(ctx.env, sessionId),
      '1',
      'EX',
      ctx.refreshTokenTtlDays * 24 * 60 * 60,
    );
  } catch (err) {
    console.error('session: failed to write mfa marker (non-fatal):', {
      name: err instanceof Error ? err.name : 'Error',
      code: (err as { code?: unknown } | null)?.code,
    });
  }
}

/**
 * Fail-CLOSED read of the OLD session's mfa marker for `refresh()`'s
 * carry-over - a Redis MISS or a Redis ERROR both resolve to `false`.
 */
export async function readMfaMarker(ctx: MfaMarkerCtx, sessionId: string): Promise<boolean> {
  try {
    const value = await ctx.redis.get(mfaMarkerKey(ctx.env, sessionId));
    return value === '1';
  } catch (err) {
    console.error('session: failed to read mfa marker, failing closed (non-fatal):', {
      name: err instanceof Error ? err.name : 'Error',
      code: (err as { code?: unknown } | null)?.code,
    });
    return false;
  }
}

/**
 * Best-effort delete of the OLD session's mfa marker after a successful
 * rotation - a failure is non-fatal (the key self-heals at TTL expiry).
 */
export async function deleteMfaMarker(ctx: MfaMarkerCtx, sessionId: string): Promise<void> {
  try {
    await ctx.redis.del(mfaMarkerKey(ctx.env, sessionId));
  } catch {
    // Best-effort only - see doc comment above.
  }
}
