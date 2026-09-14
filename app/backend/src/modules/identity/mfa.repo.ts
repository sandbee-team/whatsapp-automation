import type { TenantQueryable } from '@wp/db';

/**
 * mfa.repo.ts (P04a FIXD, split out of identity.repo.ts for max-lines) -
 * TOTP enrolment state + `mfa_recovery_codes` reads/writes. Same "no
 * client_id" class as the rest of identity.repo.ts (see migration 0014
 * header comment). Pure code motion: no behavior change from the original
 * identity.repo.ts.
 */

export interface UserTotpState {
  totpSecretEnc: Buffer | null;
  mfaEnabledAt: Date | null;
}

/** Reads the sealed TOTP secret + enrolment state for `userId`. Returns `null` when no such user exists. */
export async function getUserTotpState(
  sql: TenantQueryable,
  userId: string,
): Promise<UserTotpState | null> {
  const result = await sql.query<{
    mfa_totp_secret_enc: Buffer | null;
    mfa_enabled_at: Date | null;
  }>(`SELECT mfa_totp_secret_enc, mfa_enabled_at FROM users WHERE id = $1`, [userId]);
  const row = result.rows[0];
  if (!row) return null;
  return { totpSecretEnc: row.mfa_totp_secret_enc, mfaEnabledAt: row.mfa_enabled_at };
}

/** Persists the sealed (never plaintext) TOTP secret - does NOT touch `mfa_enabled_at` (enrolStart only). */
export async function setUserTotpSecretEnc(
  sql: TenantQueryable,
  userId: string,
  secretEnc: Buffer,
): Promise<void> {
  await sql.query(`UPDATE users SET mfa_totp_secret_enc = $2 WHERE id = $1`, [userId, secretEnc]);
}

/** Marks MFA as enrolled (enrolConfirm only, after a successful code verification). */
export async function setMfaEnabledAt(
  sql: TenantQueryable,
  userId: string,
  enabledAt: Date,
): Promise<void> {
  await sql.query(`UPDATE users SET mfa_enabled_at = $2 WHERE id = $1`, [userId, enabledAt]);
}

export interface InsertMfaRecoveryCodeInput {
  id: string;
  userId: string;
  /** SHA-256 digest of the raw recovery code - the raw code is never stored. */
  codeHash: Buffer;
}

/** Inserts one `mfa_recovery_codes` row per call - `enrolConfirm` calls this once per generated code. */
export async function insertMfaRecoveryCode(
  sql: TenantQueryable,
  input: InsertMfaRecoveryCodeInput,
): Promise<void> {
  await sql.query(`INSERT INTO mfa_recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)`, [
    input.id,
    input.userId,
    input.codeHash,
  ]);
}

/**
 * FIX 11b (P04a FIXB): deletes every still-UNUSED recovery code for `userId`
 * - called at the START of the single transaction enrolConfirm runs (totp.service.ts)
 * so a fresh set of 10 never accumulates alongside a stale set (this codepath
 * is now unreachable for an ALREADY-enrolled user - FIX 11a - so in practice
 * this only ever clears rows from an interrupted prior enrolment attempt).
 * Used (`used_at IS NOT NULL`) rows are left alone - they are historical
 * record, not live credentials.
 */
export async function deleteUnusedMfaRecoveryCodes(
  sql: TenantQueryable,
  userId: string,
): Promise<void> {
  await sql.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL`, [
    userId,
  ]);
}

/**
 * One-time use at the STORAGE layer (core invariant 3): a single conditional
 * `UPDATE ... WHERE used_at IS NULL RETURNING id` claims the row - zero rows
 * back means "already used or never existed", never distinguished further.
 */
export async function claimMfaRecoveryCode(
  sql: TenantQueryable,
  userId: string,
  codeHash: Buffer,
  usedAt: Date,
): Promise<boolean> {
  const result = await sql.query<{ id: string }>(
    `UPDATE mfa_recovery_codes SET used_at = $3
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
      RETURNING id`,
    [userId, codeHash, usedAt],
  );
  return result.rows.length > 0;
}
