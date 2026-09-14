import type { TenantQueryable } from '@wp/db';

/**
 * identity.repo.ts (P04a Unit A3) - SQL ONLY. Every function here runs a
 * single statement against `sql` (the caller's own transaction handle - see
 * `@wp/db`'s `TenantQueryable`) and does no branching on business outcome;
 * error mapping (unique-violation -> typed conflict) lives in
 * modules/identity/signup.service.ts.
 *
 * P04a FIXD: holds only `users` + email-verification-token + login-counter
 * functions now - the rest of the original file was split (pure code
 * motion, same exported names/transaction boundaries) into
 * auth-sessions.repo.ts, tenancy-scoped.repo.ts and mfa.repo.ts, and
 * re-exported below so every existing `import * as identityRepo` / named
 * import in this module keeps seeing the same barrel of names.
 */

export interface InsertUserInput {
  id: string;
  fullName: string;
  email: string;
  phoneE164?: string | null;
  passwordHash?: string | null;
}

/** Inserts one `users` row. Throws the raw driver error on conflict (e.g. `users_email_key`). */
export async function insertUser(sql: TenantQueryable, input: InsertUserInput): Promise<void> {
  await sql.query(
    `INSERT INTO users (id, full_name, email, phone_e164, password_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.id, input.fullName, input.email, input.phoneE164 ?? null, input.passwordHash ?? null],
  );
}

export interface InsertEmailVerificationTokenInput {
  id: string;
  userId: string;
  /** SHA-256 digest of the raw token - the raw token itself is never stored (only carried in the verify URL). */
  tokenHash: Buffer;
  expiresAt: Date;
}

/** Inserts one `email_verification_tokens` row. */
export async function insertEmailVerificationToken(
  sql: TenantQueryable,
  input: InsertEmailVerificationTokenInput,
): Promise<void> {
  await sql.query(
    `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [input.id, input.userId, input.tokenHash, input.expiresAt],
  );
}

/**
 * ---------------------------------------------------------------------
 * P04a Unit A4 (login.service.ts) additions below. `users` carries no
 * `client_id` (identity is global - migration 0005's "NON-tenant tables"
 * comment) and has no RLS, so every function here runs against a plain
 * connection/transaction, not a `TenantDb.withTenant` scope.
 * ---------------------------------------------------------------------
 */

export interface UserForLogin {
  id: string;
  fullName: string;
  email: string;
  passwordHash: string | null;
  passwordUpdatedAt: Date | null;
  emailVerifiedAt: Date | null;
  mfaEnabledAt: Date | null;
  tokenEpoch: number;
  failedLoginCount: number;
  lockedUntil: Date | null;
  /** FIX 6 (P04a FIXA): 'active' | 'disabled' (migration 0002 user_status enum) - login.service.ts denies any non-'active' status. */
  status: string;
}

interface UserForLoginRow extends Record<string, unknown> {
  id: string;
  full_name: string;
  email: string;
  password_hash: string | null;
  password_updated_at: Date | null;
  email_verified_at: Date | null;
  mfa_enabled_at: Date | null;
  token_epoch: number;
  failed_login_count: number;
  locked_until: Date | null;
  status: string;
}

/** Looks up one `users` row by email for the login use-case. Returns `null` when no such user exists. */
export async function findUserForLogin(
  sql: TenantQueryable,
  email: string,
): Promise<UserForLogin | null> {
  const result = await sql.query<UserForLoginRow>(
    `SELECT id, full_name, email, password_hash, password_updated_at, email_verified_at,
            mfa_enabled_at, token_epoch, failed_login_count, locked_until, status
       FROM users
      WHERE email = $1`,
    [email],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    passwordHash: row.password_hash,
    passwordUpdatedAt: row.password_updated_at,
    emailVerifiedAt: row.email_verified_at,
    mfaEnabledAt: row.mfa_enabled_at,
    tokenEpoch: row.token_epoch,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    status: row.status,
  };
}

/** Atomically increments `failed_login_count` and returns the new value. */
export async function incrementFailedLoginCount(
  sql: TenantQueryable,
  userId: string,
): Promise<number> {
  const result = await sql.query<{ failed_login_count: number }>(
    `UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = $1 RETURNING failed_login_count`,
    [userId],
  );
  return Number(result.rows[0]!.failed_login_count);
}

/** Sets `locked_until` (the lockout ladder's decision lives in login.service.ts). */
export async function setLockout(
  sql: TenantQueryable,
  userId: string,
  lockedUntil: Date,
): Promise<void> {
  await sql.query(`UPDATE users SET locked_until = $2 WHERE id = $1`, [userId, lockedUntil]);
}

/** Successful login: clears the failure counter/lockout and records `last_login_at`. */
export async function resetFailedLoginAndRecordSuccess(
  sql: TenantQueryable,
  userId: string,
  lastLoginAt: Date,
): Promise<void> {
  await sql.query(
    `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1`,
    [userId, lastLoginAt],
  );
}

/** Rehash-on-login: persists a freshly-hashed `password_hash` under current cost params. */
export async function updatePasswordHash(
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

/**
 * ---------------------------------------------------------------------
 * P04a Unit A5a (session.service.ts / token-epoch.ts / verify-email.service.ts)
 * additions below. Same "no client_id/RLS" class as the rest of this file
 * (auth_sessions, email_verification_tokens are user-keyed, not tenant-keyed
 * - migration 0013's header comment).
 * ---------------------------------------------------------------------
 */

/** Reads the CURRENT `users.token_epoch` - Postgres is the authority (Redis is only a cache). */
export async function getUserTokenEpoch(sql: TenantQueryable, userId: string): Promise<number> {
  const result = await sql.query<{ token_epoch: number }>(
    `SELECT token_epoch FROM users WHERE id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`getUserTokenEpoch: no such user ${userId}`);
  }
  return Number(row.token_epoch);
}

/** Atomically bumps `users.token_epoch` (logout invalidates every previously-issued access token). */
export async function bumpTokenEpoch(sql: TenantQueryable, userId: string): Promise<number> {
  const result = await sql.query<{ token_epoch: number }>(
    `UPDATE users SET token_epoch = token_epoch + 1 WHERE id = $1 RETURNING token_epoch`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`bumpTokenEpoch: no such user ${userId}`);
  }
  return Number(row.token_epoch);
}

export async function getUserEmailById(sql: TenantQueryable, userId: string): Promise<string> {
  const result = await sql.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
    userId,
  ]);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`getUserEmailById: no such user ${userId}`);
  }
  return row.email;
}

/**
 * Consumes one `email_verification_tokens` row: idempotency at the storage
 * layer (core invariant 3) via a single conditional `UPDATE ... RETURNING`
 * rather than check-then-write - a replay or expired token yields zero rows,
 * which the caller (verify-email.service.ts) turns into one generic typed
 * error that never reveals whether the token ever existed.
 */
export async function consumeEmailVerificationToken(
  sql: TenantQueryable,
  tokenHash: Buffer,
  consumedAt: Date,
): Promise<string | null> {
  const result = await sql.query<{ user_id: string }>(
    `UPDATE email_verification_tokens SET consumed_at = $2
      WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2
      RETURNING user_id`,
    [tokenHash, consumedAt],
  );
  return result.rows[0]?.user_id ?? null;
}

/** Sets `users.email_verified_at` - conditional on it still being unset, so a replay never overwrites the first timestamp. */
export async function setEmailVerifiedAt(
  sql: TenantQueryable,
  userId: string,
  verifiedAt: Date,
): Promise<void> {
  await sql.query(
    `UPDATE users SET email_verified_at = $2 WHERE id = $1 AND email_verified_at IS NULL`,
    [userId, verifiedAt],
  );
}

// ---------------------------------------------------------------------
// Barrel re-exports (P04a FIXD) - see the header comment above.
// ---------------------------------------------------------------------
export {
  type Membership,
  findMembershipForUser,
  type AuthSession,
  type InsertAuthSessionInput,
  insertAuthSession,
  findAuthSessionByRefreshTokenHash,
  findAuthSessionById,
  revokeAuthSession,
  revokeAuthSessionsBulk,
  findSessionChainIds,
  type InsertReuseDetectedAuditLogInput,
  insertReuseDetectedAuditLog,
} from './auth-sessions.repo.js';

export {
  findClientIdForUser,
  setAppClientId,
  type InsertLockoutAuditLogInput,
  insertLockoutAuditLog,
  advanceOnboardingStepAfterEmailVerification,
  activateClientIfPending,
  getClientOnboardingStep,
  type MeRow,
  fetchMeRow,
  type MeDbClient,
  type MeDbPool,
  getMeForUser,
  type BasicUser,
  fetchBasicUser,
} from './tenancy-scoped.repo.js';

export {
  type UserTotpState,
  getUserTotpState,
  setUserTotpSecretEnc,
  setMfaEnabledAt,
  type InsertMfaRecoveryCodeInput,
  insertMfaRecoveryCode,
  deleteUnusedMfaRecoveryCodes,
  claimMfaRecoveryCode,
} from './mfa.repo.js';
