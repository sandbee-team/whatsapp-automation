import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TenantQueryable } from '@wp/db';
import { hashPassword, verifyPassword, type Argon2Params } from './password.js';
import { writeEpochCache } from './token-epoch.js';
import * as identityRepo from './identity.repo.js';
import * as passwordRepo from './password.repo.js';
import { provisioningRepo } from '../tenancy/index.js';

/**
 * password.service.ts (P28 U5, item 1) - the password change/forgot/reset
 * use cases. `users`/`auth_sessions`/`password_reset_tokens` carry no
 * `client_id`/RLS (identity is global), so every use case here runs its OWN
 * BEGIN/COMMIT/ROLLBACK against a plain pool connection, exactly like
 * login.service.ts/session.service.ts.
 *
 * `changePassword` deliberately does NOT bump `token_epoch`: the caller's
 * OWN current session must stay alive (the route's own contract:
 * `{changed, otherSessionsRevoked}` - the caller keeps using the access
 * token it already holds), and every OTHER `auth_sessions` row is revoked
 * directly instead. Bumping the epoch would also invalidate the CURRENT
 * access token (token-epoch.ts's `validateAccessToken` compares the token's
 * `epoch` claim against the live value), forcing the caller to immediately
 * re-authenticate right after a successful change - contrary to the route's
 * own "the current session survives" contract. `resetPassword` is the
 * opposite case (the caller is UNAUTHENTICATED at reset time - there is no
 * session to spare) and DOES bump the epoch, same as `session-logout.ts`'s
 * `logout()`.
 */

export class WrongCurrentPasswordError extends Error {
  readonly code = 'UNAUTHENTICATED';
  readonly details: Record<string, unknown>;
  constructor() {
    super('The current password is incorrect.');
    this.name = 'WrongCurrentPasswordError';
    this.details = { field: 'currentPassword' };
  }
}

export interface PasswordDbClient extends TenantQueryable {
  release(err?: unknown): void;
}

export interface PasswordDbPool {
  connect(): Promise<PasswordDbClient>;
}

export interface PasswordCtx {
  pool: PasswordDbPool;
  argon2Params: Argon2Params;
  publicBaseUrl: string;
  resetTokenTtlMinutes: number;
  /** Redis-cached epoch write port - `resetPassword` only (see the module doc comment). */
  redisEpochCtx: Parameters<typeof writeEpochCache>[0];
  sendPasswordResetEmail: (to: string, resetUrl: string) => Promise<void>;
  now?: () => Date;
  generateId?: () => string;
}

export interface ChangePasswordInput {
  userId: string;
  currentSessionId: string;
  currentPassword: string;
  newPassword: string;
}

export interface ChangePasswordResult {
  otherSessionsRevoked: number;
}

/** `POST /v1/auth/password/change` - see the module doc comment for why this never bumps `token_epoch`. */
export async function changePassword(
  ctx: PasswordCtx,
  input: ChangePasswordInput,
): Promise<ChangePasswordResult> {
  const now = ctx.now ?? (() => new Date());
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    const user = await passwordRepo.findUserById(client, input.userId);
    if (!user) {
      await client.query('ROLLBACK');
      throw new WrongCurrentPasswordError();
    }

    // Constant-time path even when the hash is null (a future passkey-only
    // account) - same dummy-verify-shaped discipline as login.service.ts's
    // no-hash branch, so a missing hash never short-circuits the timing.
    const passwordOk = user.passwordHash
      ? await verifyPassword(user.passwordHash, input.currentPassword)
      : await verifyPassword(
          await hashPassword('wp-password-change-dummy-verify', ctx.argon2Params),
          input.currentPassword,
        );
    if (!passwordOk) {
      await client.query('ROLLBACK');
      throw new WrongCurrentPasswordError();
    }

    const changedAt = now();
    const newHash = await hashPassword(input.newPassword, ctx.argon2Params);
    await passwordRepo.updatePasswordHashAndTimestamp(client, user.id, newHash, changedAt);
    const otherSessionsRevoked = await passwordRepo.revokeOtherAuthSessions(
      client,
      user.id,
      input.currentSessionId,
      changedAt,
    );

    const clientId = await identityRepo.findClientIdForUser(client, user.id);
    if (clientId) {
      await identityRepo.setAppClientId(client, clientId);
      await provisioningRepo.insertAuditLog(client, {
        clientId,
        actorType: 'user',
        actorUserId: user.id,
        action: 'auth.password.change',
        targetType: 'user',
        targetId: user.id,
        metadata: { sessionsRevoked: otherSessionsRevoked },
      });
    }

    await client.query('COMMIT');
    return { otherSessionsRevoked };
  } catch (err) {
    if (!(err instanceof WrongCurrentPasswordError)) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is what must propagate, not a rollback failure.
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface ForgotPasswordInput {
  email: string;
}

const RESET_TOKEN_BYTES = 32;

/**
 * `POST /v1/auth/password/forgot` - ALWAYS resolves (never throws for "no
 * such user"), same existence-oracle discipline as login.service.ts's dummy
 * verify: an unknown email does no DB write and sends no mail, but the
 * caller (password.routes.ts) returns the identical `{accepted: true}`
 * response either way.
 */
export async function forgotPassword(ctx: PasswordCtx, input: ForgotPasswordInput): Promise<void> {
  const now = ctx.now ?? (() => new Date());
  const generateId = ctx.generateId ?? randomUUID;
  const client = await ctx.pool.connect();
  let notifyEmail: { to: string; resetUrl: string } | null = null;

  try {
    await client.query('BEGIN');
    const user = await passwordRepo.findUserByEmailForPasswordFlow(client, input.email);
    if (user && user.status === 'active') {
      const issuedAt = now();
      const rawToken = randomBytes(RESET_TOKEN_BYTES);
      const tokenHash = createHash('sha256').update(rawToken).digest();
      const expiresAt = new Date(issuedAt.getTime() + ctx.resetTokenTtlMinutes * 60_000);

      // Invalidate older unconsumed tokens BEFORE inserting the new one - a
      // fresh request supersedes any earlier still-live reset link.
      await passwordRepo.invalidateUnconsumedPasswordResetTokens(client, user.id, issuedAt);
      await passwordRepo.insertPasswordResetToken(client, {
        id: generateId(),
        userId: user.id,
        tokenHash,
        expiresAt,
      });

      const clientId = await identityRepo.findClientIdForUser(client, user.id);
      if (clientId) {
        await identityRepo.setAppClientId(client, clientId);
        await provisioningRepo.insertAuditLog(client, {
          clientId,
          actorType: 'user',
          actorUserId: user.id,
          action: 'auth.password.forgot_requested',
          targetType: 'user',
          targetId: user.id,
        });
      }

      notifyEmail = {
        to: user.email,
        resetUrl: `${ctx.publicBaseUrl}/reset-password?token=${rawToken.toString('hex')}`,
      };
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is what must propagate, not a rollback failure.
    }
    throw err;
  } finally {
    client.release();
  }

  // AFTER COMMIT ONLY - a mail failure is logged, never thrown (core
  // invariant: a provider/mail call never happens inside a DB transaction).
  if (notifyEmail) {
    try {
      await ctx.sendPasswordResetEmail(notifyEmail.to, notifyEmail.resetUrl);
    } catch (err) {
      console.error('forgotPassword: failed to send password reset email (non-fatal):', {
        name: err instanceof Error ? err.name : 'Error',
        code: (err as { code?: unknown } | null)?.code,
      });
    }
  }
}

// `resetPassword` (the UNAUTHENTICATED half of this flow - see the module
// doc comment above for why it DOES bump `token_epoch`, the opposite of
// `changePassword` above) lives in the sibling password-reset.service.ts
// (P28 U5, max-lines split) - re-exported here so `password.routes.ts`'s
// existing `from './password.service.js'` import keeps compiling unchanged.
export {
  resetPassword,
  InvalidOrExpiredResetTokenError,
  type ResetPasswordInput,
} from './password-reset.service.js';
