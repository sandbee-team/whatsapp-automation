import { randomUUID } from 'node:crypto';
import type { StaffRole } from '@wp/domain';
import type { AdminReadQueryable } from '../../platform/platform-read.js';

/**
 * modules/staff-auth/sessions.ts (P28 Unit U4, step 6) - the ONLY module in
 * admin-backend that writes anything other than `audit_logs`, and it writes
 * to exactly two non-tenant tables: `staff_users` (lockout counters, MFA
 * state, `token_epoch`, `last_login_at`) and `staff_sessions` (refresh-token
 * rows). Those are WP's own staff identity, not tenant data - ADR 0014 fact
 * 1/12 forbids admin-backend writing TENANT or SEND-PATH data, and the
 * `wp_admin_app` grant surface enforces exactly that split (migration 0070).
 *
 * Every statement here runs on a transaction that has already entered
 * `wp_admin_app`, supplied by `platform-read.ts`'s `withStaffRoleTx` -
 * deliberately a SEPARATE helper from `platformRead()`, because a login is
 * not a cross-tenant read: it writes no `platform.read` audit row (its own
 * `staff.login.*` events are written by `writeStaffAuditEvent`), and a
 * FAILED attempt must still persist its counter increment, which is the
 * opposite of `platformRead`'s roll-back-everything-on-failure rule. That
 * helper lives in `platform-read.ts` because that file is the ONLY one
 * allowed to issue the role change at all (its own source-scan test pins
 * this), so this module never issues SQL that changes the connection's role.
 */

export interface StaffUserRow {
  id: string;
  email: string;
  fullName: string;
  passwordHash: string;
  role: StaffRole;
  status: string;
  mfaTotpSecretEnc: Buffer | null;
  mfaEnabledAt: Date | null;
  tokenEpoch: number;
  failedLoginCount: number;
  lockedUntil: Date | null;
}

interface RawStaffUserRow extends Record<string, unknown> {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  role: StaffRole;
  status: string;
  mfa_totp_secret_enc: Buffer | null;
  mfa_enabled_at: Date | null;
  token_epoch: string;
  failed_login_count: number;
  locked_until: Date | null;
}

function mapStaffUser(row: RawStaffUserRow): StaffUserRow {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    passwordHash: row.password_hash,
    role: row.role,
    status: row.status,
    mfaTotpSecretEnc: row.mfa_totp_secret_enc,
    mfaEnabledAt: row.mfa_enabled_at,
    tokenEpoch: Number(row.token_epoch),
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
  };
}

const STAFF_USER_COLUMNS = `id, email::text AS email, full_name, password_hash, role,
         status, mfa_totp_secret_enc, mfa_enabled_at, token_epoch::text AS token_epoch,
         failed_login_count, locked_until`;

/** Loads one staff user by email (citext, so case-insensitive); `undefined` when no such account exists. */
export async function findStaffUserByEmail(
  db: AdminReadQueryable,
  email: string,
): Promise<StaffUserRow | undefined> {
  const result = await db.query<RawStaffUserRow>(
    `SELECT ${STAFF_USER_COLUMNS} FROM staff_users WHERE email = $1`,
    [email],
  );
  const row = result.rows[0];
  return row ? mapStaffUser(row) : undefined;
}

/** Loads one staff user by id - the per-request epoch/status check in `authenticateStaff`. */
export async function findStaffUserById(
  db: AdminReadQueryable,
  staffId: string,
): Promise<StaffUserRow | undefined> {
  const result = await db.query<RawStaffUserRow>(
    `SELECT ${STAFF_USER_COLUMNS} FROM staff_users WHERE id = $1`,
    [staffId],
  );
  const row = result.rows[0];
  return row ? mapStaffUser(row) : undefined;
}

/** Increments the failure counter (and optionally sets `locked_until`) - the ONE statement the failure path writes. */
export async function recordLoginFailure(
  db: AdminReadQueryable,
  input: { staffId: string; lockedUntil: Date | null },
): Promise<void> {
  await db.query(
    // `SET` stays on the `UPDATE` line: the `wp/no-plain-set` guard matches a
    // line-leading `SET `, which a wrapped clause would trip (same note as
    // app-backend's internal-access.ts#markTopupDecided).
    `UPDATE staff_users SET failed_login_count = failed_login_count + 1,
            locked_until = COALESCE($2, locked_until), updated_at = now()
      WHERE id = $1`,
    [input.staffId, input.lockedUntil],
  );
}

/** Resets the lockout counters and stamps `last_login_at` - the success path's only `staff_users` write. */
export async function recordLoginSuccess(
  db: AdminReadQueryable,
  input: { staffId: string; now: Date },
): Promise<void> {
  await db.query(
    `UPDATE staff_users SET failed_login_count = 0, locked_until = NULL,
            last_login_at = $2, updated_at = now()
      WHERE id = $1`,
    [input.staffId, input.now],
  );
}

export interface StaffSessionRow {
  id: string;
  staffId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
}

/** Creates one refresh-token session row. Only the token's SHA-256 is stored (see `tokens.ts`). */
export async function createStaffSession(
  db: AdminReadQueryable,
  input: {
    staffId: string;
    refreshTokenHash: Buffer;
    ip: string | null;
    userAgentHash: string | null;
    expiresAt: Date;
  },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO staff_sessions (id, staff_id, refresh_token_hash, ip, user_agent_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, input.staffId, input.refreshTokenHash, input.ip, input.userAgentHash, input.expiresAt],
  );
  return id;
}

/**
 * Looks a session up by refresh-token hash, WITHOUT filtering on
 * revoked/expired - the caller needs to distinguish "unknown token"
 * (nothing to see here) from "known but already-rotated token", because the
 * second is a REUSE and triggers the full-revocation sweep. Filtering here
 * would silently turn a reuse into a plain 401 and lose that signal.
 */
export async function findStaffSessionByHash(
  db: AdminReadQueryable,
  refreshTokenHash: Buffer,
): Promise<StaffSessionRow | undefined> {
  const result = await db.query<{
    id: string;
    staff_id: string;
    expires_at: Date;
    revoked_at: Date | null;
    replaced_by: string | null;
  }>(
    `SELECT id, staff_id, expires_at, revoked_at, replaced_by
       FROM staff_sessions WHERE refresh_token_hash = $1`,
    [refreshTokenHash],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        staffId: row.staff_id,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        replacedBy: row.replaced_by,
      }
    : undefined;
}

/** Rotates one session: revokes the old row and points it at its successor (conditional on it not already being revoked). */
export async function rotateStaffSession(
  db: AdminReadQueryable,
  input: { oldSessionId: string; newSessionId: string; now: Date },
): Promise<number> {
  const result = await db.query(
    `UPDATE staff_sessions SET revoked_at = $3, replaced_by = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [input.oldSessionId, input.newSessionId, input.now],
  );
  return result.rowCount ?? 0;
}

/** Revokes ONE session (logout). */
export async function revokeStaffSession(
  db: AdminReadQueryable,
  input: { sessionId: string; now: Date },
): Promise<void> {
  await db.query(`UPDATE staff_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [
    input.sessionId,
    input.now,
  ]);
}

/**
 * The reuse-detection sweep: revokes EVERY live session of one staff member
 * and bumps `token_epoch`, in one statement pair inside the caller's
 * transaction. Bumping the epoch is what kills the outstanding 2-minute
 * ACCESS tokens too - without it, revoking the refresh rows would leave a
 * stolen access token usable for up to two more minutes.
 */
export async function revokeAllSessionsAndBumpEpoch(
  db: AdminReadQueryable,
  input: { staffId: string; now: Date },
): Promise<void> {
  await db.query(
    `UPDATE staff_sessions SET revoked_at = $2 WHERE staff_id = $1 AND revoked_at IS NULL`,
    [input.staffId, input.now],
  );
  await db.query(
    `UPDATE staff_users SET token_epoch = token_epoch + 1, updated_at = now() WHERE id = $1`,
    [input.staffId],
  );
}
