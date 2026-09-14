import * as identityRepoDefault from './identity.repo.js';
import { flushEpochCacheAfterCommit, safeRollback } from './session-internal.js';
import type { SessionCtx, SessionDbClient } from './session.service.js';

/**
 * session-logout.ts (P04b Unit UB1a, split out of session.service.ts for
 * max-lines) - `logout()` only. Pure code motion: no behavior change, same
 * transaction boundary as before (revoke the session AND bump
 * `users.token_epoch` in ONE transaction; the Redis epoch cache is flushed
 * AFTER commit only - see session.service.ts's module doc comment).
 */

type IdentityRepo = typeof identityRepoDefault;

export interface LogoutInput {
  sessionId: string;
}

/**
 * Revokes one session AND bumps `users.token_epoch` in one transaction -
 * every access token issued before this call becomes unverifiable the
 * moment the epoch cache next misses or is invalidated. A logout for an
 * unknown/already-revoked `sessionId` is a silent no-op (idempotent at the
 * storage layer, core invariant 3).
 */
export async function logout(ctx: SessionCtx, input: LogoutInput): Promise<void> {
  const identityRepo: IdentityRepo = { ...identityRepoDefault, ...ctx.identityRepo };
  const now = ctx.now ?? (() => new Date());
  const client: SessionDbClient = await ctx.pool.connect();
  let epochToCache: { userId: string; epoch: number } | null = null;

  try {
    await client.query('BEGIN');
    const session = await identityRepo.findAuthSessionById(client, input.sessionId);
    if (!session) {
      await client.query('ROLLBACK');
      return;
    }
    await identityRepo.revokeAuthSession(client, session.id, 'logout', now());
    const newEpoch = await identityRepo.bumpTokenEpoch(client, session.userId);
    await client.query('COMMIT');
    epochToCache = { userId: session.userId, epoch: newEpoch };
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
    await flushEpochCacheAfterCommit(ctx, epochToCache);
  }
}
