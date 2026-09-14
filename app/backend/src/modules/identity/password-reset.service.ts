import { createHash } from 'node:crypto';
import { hashPassword } from './password.js';
import { writeEpochCache } from './token-epoch.js';
import * as identityRepo from './identity.repo.js';
import * as passwordRepo from './password.repo.js';
import { provisioningRepo } from '../tenancy/index.js';
import type { PasswordCtx } from './password.service.js';

/**
 * password-reset.service.ts (P28 U5, item 1; split out of password.service.ts
 * for max-lines) - `resetPassword` only, the UNAUTHENTICATED half of the
 * password flow. See password.service.ts's own module doc comment for why
 * this DOES bump `token_epoch` (the opposite of `changePassword`: there is
 * no "current session" to spare here). Pure code motion otherwise - no
 * behavior change.
 */

export class InvalidOrExpiredResetTokenError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly details: Record<string, unknown>;
  constructor() {
    super('This password reset link is invalid or has expired.');
    this.name = 'InvalidOrExpiredResetTokenError';
    this.details = { reason: 'invalid_or_expired_token' };
  }
}

export interface ResetPasswordInput {
  /** Hex-encoded raw token, as carried in the reset URL. */
  token: string;
  newPassword: string;
}

/** `POST /v1/auth/password/reset` - see password.service.ts's module doc comment for why this DOES bump `token_epoch`. */
export async function resetPassword(ctx: PasswordCtx, input: ResetPasswordInput): Promise<void> {
  const now = ctx.now ?? (() => new Date());
  const tokenHash = createHash('sha256').update(Buffer.from(input.token, 'hex')).digest();
  const client = await ctx.pool.connect();
  let epochToCache: { userId: string; epoch: number } | null = null;

  try {
    await client.query('BEGIN');
    const tokenRow = await passwordRepo.findPasswordResetTokenForUpdate(client, tokenHash);
    const resetAt = now();
    if (
      !tokenRow ||
      tokenRow.consumedAt !== null ||
      tokenRow.expiresAt.getTime() <= resetAt.getTime()
    ) {
      await client.query('ROLLBACK');
      throw new InvalidOrExpiredResetTokenError();
    }

    const claimed = await passwordRepo.consumePasswordResetToken(client, tokenRow.id, resetAt);
    if (!claimed) {
      // Concurrent reset already consumed this exact token between the read
      // above and this UPDATE - same generic error, never a distinct oracle.
      await client.query('ROLLBACK');
      throw new InvalidOrExpiredResetTokenError();
    }

    const newHash = await hashPassword(input.newPassword, ctx.argon2Params);
    await passwordRepo.updatePasswordHashAndTimestamp(client, tokenRow.userId, newHash, resetAt);
    const newEpoch = await identityRepo.bumpTokenEpoch(client, tokenRow.userId);
    await passwordRepo.revokeAllAuthSessions(client, tokenRow.userId, resetAt);

    const clientId = await identityRepo.findClientIdForUser(client, tokenRow.userId);
    if (clientId) {
      await identityRepo.setAppClientId(client, clientId);
      await provisioningRepo.insertAuditLog(client, {
        clientId,
        actorType: 'user',
        actorUserId: tokenRow.userId,
        action: 'auth.password.reset',
        targetType: 'user',
        targetId: tokenRow.userId,
      });
    }

    await client.query('COMMIT');
    epochToCache = { userId: tokenRow.userId, epoch: newEpoch };
  } catch (err) {
    if (!(err instanceof InvalidOrExpiredResetTokenError)) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is what must propagate, not a rollback failure.
      }
    }
    throw err;
  } finally {
    client.release();
    // AFTER COMMIT ONLY - same "write the cache after the bump commits" rule
    // as session-logout.ts's `logout()`.
    if (epochToCache) {
      await writeEpochCache(ctx.redisEpochCtx, epochToCache.userId, epochToCache.epoch);
    }
  }
}
