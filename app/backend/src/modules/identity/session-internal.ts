import { writeEpochCache } from './token-epoch.js';
import type { SessionCtx, SessionDbClient } from './session.service.js';

/**
 * session-internal.ts (P04b Unit UB1a, split out of session.service.ts for
 * max-lines) - the two tiny private helpers `session.service.ts` AND
 * `session-logout.ts` both need (`safeRollback`/`flushEpochCacheAfterCommit`).
 * Pure code motion: no behavior change.
 */

/** See `SessionCtx.epochCacheTtlSec`'s doc comment - matches platform/config.ts's `EPOCH_CACHE_TTL_SEC` default. */
const DEFAULT_EPOCH_CACHE_TTL_SEC = 3600;

/** Best-effort ROLLBACK on an already-failed transaction - the ORIGINAL error must propagate, not a rollback failure. */
export async function safeRollback(client: SessionDbClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The original error is what must propagate, not a rollback failure.
  }
}

/** AFTER COMMIT ONLY (FIX 3/4, P04a FIXA C1 review): writes the NEW epoch (never DEL) so a racing stale fill can never re-pin a pre-logout/pre-theft epoch for a full TTL - see token-epoch.ts. No-op when `epochToCache` is null. */
export async function flushEpochCacheAfterCommit(
  ctx: Pick<SessionCtx, 'redis' | 'env' | 'epochCacheTtlSec'>,
  epochToCache: { userId: string; epoch: number } | null,
): Promise<void> {
  if (!epochToCache) return;
  await writeEpochCache(
    {
      redis: ctx.redis,
      env: ctx.env,
      epochCacheTtlSec: ctx.epochCacheTtlSec ?? DEFAULT_EPOCH_CACHE_TTL_SEC,
    },
    epochToCache.userId,
    epochToCache.epoch,
  );
}
