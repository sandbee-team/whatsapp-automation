import type { TenantQueryable } from '@wp/db';

/**
 * password.repo.ts (P28 U5, item 1) - SQL ONLY for the password change/
 * forgot/reset flow, split out as a sibling of identity.repo.ts (same "no
 * business `if`s here" discipline as provisioning.repo.ts's header comment)
 * rather than added into identity.repo.ts directly, to leave that file's
 * headroom under the 300-line cap untouched. `users`/`password_reset_tokens`
 * carry no `client_id`/RLS (identity is global - migration 0005's "NON-tenant
 * tables" comment, migration 0013's header comment for
 * `password_reset_tokens`), so every function here runs against a plain
 * connection/transaction, not a `TenantDb.withTenant` scope.
 */

/** Sets `password_hash`/`password_updated_at` - the password-change use case's own write (never bumps `token_epoch` - see password.service.ts's doc comment on why). */
export async function updatePasswordHashAndTimestamp(
  sql: TenantQueryable,
  userId: string,
  passwordHash: string,
  passwordUpdatedAt: Date,
): Promise<void> {
  await sql.query(`UPDATE users SET password_hash = $2, password_updated_at = $3 WHERE id = $1`, [
    userId,
    passwordHash,
    passwordUpdatedAt,
  ]);
}

export interface InsertPasswordResetTokenInput {
  id: string;
  userId: string;
  /** SHA-256 digest of the raw token - the raw token itself is never stored (only carried in the reset URL). */
  tokenHash: Buffer;
  expiresAt: Date;
}

/** Inserts one `password_reset_tokens` row. */
export async function insertPasswordResetToken(
  sql: TenantQueryable,
  input: InsertPasswordResetTokenInput,
): Promise<void> {
  await sql.query(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [input.id, input.userId, input.tokenHash, input.expiresAt],
  );
}

/** Invalidates every older, still-unconsumed `password_reset_tokens` row for `userId` - a fresh forgot-password request supersedes any earlier one. */
export async function invalidateUnconsumedPasswordResetTokens(
  sql: TenantQueryable,
  userId: string,
  consumedAt: Date,
): Promise<void> {
  await sql.query(
    `UPDATE password_reset_tokens SET consumed_at = $2 WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId, consumedAt],
  );
}

export interface PasswordResetTokenRow {
  id: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface PasswordResetTokenRowRaw extends Record<string, unknown> {
  id: string;
  user_id: string;
  expires_at: Date;
  consumed_at: Date | null;
}

/** Locks and reads one `password_reset_tokens` row by its (SHA-256'd) token - `FOR UPDATE` so a concurrent reset of the same token cannot double-consume it. */
export async function findPasswordResetTokenForUpdate(
  sql: TenantQueryable,
  tokenHash: Buffer,
): Promise<PasswordResetTokenRow | null> {
  const result = await sql.query<PasswordResetTokenRowRaw>(
    `SELECT id, user_id, expires_at, consumed_at
       FROM password_reset_tokens
      WHERE token_hash = $1
      FOR UPDATE`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

/** Conditionally marks one `password_reset_tokens` row consumed - a no-op (0 rows) if it was already consumed by a racing request. Returns whether THIS call claimed it. */
export async function consumePasswordResetToken(
  sql: TenantQueryable,
  id: string,
  consumedAt: Date,
): Promise<boolean> {
  const result = await sql.query<{ id: string }>(
    `UPDATE password_reset_tokens SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
    [id, consumedAt],
  );
  return result.rows.length > 0;
}

interface UserForPasswordFlowRow extends Record<string, unknown> {
  id: string;
  email: string;
  password_hash: string | null;
  status: string;
}

export interface UserForPasswordFlow {
  id: string;
  email: string;
  passwordHash: string | null;
  status: string;
}

/** Looks up one `users` row by id for the password-change use case. */
export async function findUserById(
  sql: TenantQueryable,
  userId: string,
): Promise<UserForPasswordFlow | null> {
  const result = await sql.query<UserForPasswordFlowRow>(
    `SELECT id, email, password_hash, status FROM users WHERE id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, email: row.email, passwordHash: row.password_hash, status: row.status };
}

/** Looks up one `users` row by email for the forgot-password use case - `null` when no such user exists (never an existence oracle by itself; the service layer is what keeps the response uniform). */
export async function findUserByEmailForPasswordFlow(
  sql: TenantQueryable,
  email: string,
): Promise<UserForPasswordFlow | null> {
  const result = await sql.query<UserForPasswordFlowRow>(
    `SELECT id, email, password_hash, status FROM users WHERE email = $1`,
    [email],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, email: row.email, passwordHash: row.password_hash, status: row.status };
}

/** Revokes every OTHER unrevoked `auth_sessions` row for `userId` (never `currentSessionId` itself) - the password-change use case's "kill every other session, keep this one alive" write. Returns the number of rows actually revoked. */
export async function revokeOtherAuthSessions(
  sql: TenantQueryable,
  userId: string,
  currentSessionId: string,
  revokedAt: Date,
): Promise<number> {
  const result = await sql.query<{ id: string }>(
    `UPDATE auth_sessions SET revoked_at = $3, revoked_reason = 'password_change', updated_at = now()
      WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL
      RETURNING id`,
    [userId, currentSessionId, revokedAt],
  );
  return result.rows.length;
}

/** Revokes EVERY unrevoked `auth_sessions` row for `userId` - the password-reset use case's "kill every session, including the caller's own" write (the caller is unauthenticated at reset time - there is no "current" session to spare). */
export async function revokeAllAuthSessions(
  sql: TenantQueryable,
  userId: string,
  revokedAt: Date,
): Promise<void> {
  await sql.query(
    `UPDATE auth_sessions SET revoked_at = $2, revoked_reason = 'password_reset', updated_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, revokedAt],
  );
}
