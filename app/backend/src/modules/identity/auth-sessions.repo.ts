import type { TenantQueryable } from '@wp/db';

/**
 * auth-sessions.repo.ts (P04a FIXD, split out of identity.repo.ts for
 * max-lines) - `auth_sessions` insert/find/revoke/chain-walk, plus the one
 * reuse-detection audit-log write session.service.ts's sweep pairs with a
 * chain revocation. Same "no client_id/RLS" class as the rest of
 * identity.repo.ts (auth_sessions is user-keyed, not tenant-keyed -
 * migration 0013's header comment). Pure code motion: no behavior change
 * from the original identity.repo.ts.
 */

export interface Membership {
  clientId: string;
  role: string;
}

/**
 * Resolves the (clientId, role) pair a freshly-issued or rotated access
 * token's `clientId`/`role` claims are minted from - session issuance never
 * trusts a caller-supplied clientId/role, only what memberships actually
 * says right now (see tenancy-scoped.repo.ts's `findClientIdForUser` same
 * one-workspace-per-user note: `memberships_one_workspace_per_user_uq`
 * guarantees at most one row).
 */
export async function findMembershipForUser(
  sql: TenantQueryable,
  userId: string,
): Promise<Membership | null> {
  const result = await sql.query<{ client_id: string; role: string }>(
    `SELECT client_id, role
       FROM memberships
      WHERE user_id = $1
      LIMIT 1
      -- client_id = memberships.client_id (the projected column IS the value
      -- being resolved here - see the doc comment above findMembershipForUser)
    `,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { clientId: row.client_id, role: row.role };
}

export interface AuthSession {
  id: string;
  userId: string;
  refreshTokenHash: Buffer;
  parentSessionId: string | null;
  issuedAt: Date;
  expiresAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
}

interface AuthSessionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  refresh_token_hash: Buffer;
  parent_session_id: string | null;
  issued_at: Date;
  expires_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
}

function mapAuthSessionRow(row: AuthSessionRow): AuthSession {
  return {
    id: row.id,
    userId: row.user_id,
    refreshTokenHash: row.refresh_token_hash,
    parentSessionId: row.parent_session_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

const AUTH_SESSION_COLUMNS = `id, user_id, refresh_token_hash, parent_session_id, issued_at, expires_at, last_seen_at, revoked_at, revoked_reason`;

export interface InsertAuthSessionInput {
  id: string;
  userId: string;
  refreshTokenHash: Buffer;
  parentSessionId: string | null;
  issuedAt: Date;
  expiresAt: Date;
}

/** Inserts one `auth_sessions` row - the ONLY write path for a rotation-chain link (see `parentSessionId`). */
export async function insertAuthSession(
  sql: TenantQueryable,
  input: InsertAuthSessionInput,
): Promise<void> {
  await sql.query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, parent_session_id, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.userId,
      input.refreshTokenHash,
      input.parentSessionId,
      input.issuedAt,
      input.expiresAt,
    ],
  );
}

/** Looks up one `auth_sessions` row by its (SHA-256'd) refresh token - the raw token is never stored. */
export async function findAuthSessionByRefreshTokenHash(
  sql: TenantQueryable,
  refreshTokenHash: Buffer,
): Promise<AuthSession | null> {
  const result = await sql.query<AuthSessionRow>(
    `SELECT ${AUTH_SESSION_COLUMNS} FROM auth_sessions WHERE refresh_token_hash = $1`,
    [refreshTokenHash],
  );
  const row = result.rows[0];
  return row ? mapAuthSessionRow(row) : null;
}

export async function findAuthSessionById(
  sql: TenantQueryable,
  id: string,
): Promise<AuthSession | null> {
  const result = await sql.query<AuthSessionRow>(
    `SELECT ${AUTH_SESSION_COLUMNS} FROM auth_sessions WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapAuthSessionRow(row) : null;
}

/**
 * Idempotent at the storage layer (core invariant 3): only revokes a row
 * that is STILL unrevoked (`revoked_at IS NULL`) - an already-revoked row
 * (e.g. one caught mid-reuse-detection-sweep) keeps its original
 * `revoked_reason`, never overwritten by a later, less-specific call.
 *
 * Returns whether THIS call actually claimed the row (`RETURNING id` had a
 * row) - FIX 2 (P04a FIXA C1 review, lost-update race): the `refresh()` use
 * case in session.service.ts uses this boolean as the rotation CLAIM GATE.
 * A `false` means the presented session was concurrently rotated/revoked by
 * another in-flight `refresh()`/`logout()` between this transaction own
 * read and this UPDATE - the Postgres row lock is the arbiter here, not an
 * in-memory check.
 */
export async function revokeAuthSession(
  sql: TenantQueryable,
  id: string,
  reason: string,
  revokedAt: Date,
): Promise<boolean> {
  const result = await sql.query<{ id: string }>(
    `UPDATE auth_sessions SET revoked_at = $2, revoked_reason = $3, updated_at = now()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [id, revokedAt, reason],
  );
  return result.rows.length > 0;
}

/** Same conditional semantics as `revokeAuthSession`, applied to every id in one statement. */
export async function revokeAuthSessionsBulk(
  sql: TenantQueryable,
  ids: string[],
  reason: string,
  revokedAt: Date,
): Promise<void> {
  if (ids.length === 0) return;
  await sql.query(
    `UPDATE auth_sessions SET revoked_at = $2, revoked_reason = $3, updated_at = now()
      WHERE id = ANY($1) AND revoked_at IS NULL`,
    [ids, revokedAt, reason],
  );
}

/**
 * Walks the rotation chain BOTH directions (ancestors via `parent_session_id`
 * going up, descendants going down) from `id` - reuse detection (canon)
 * needs every session ever descended from or leading to the presented row,
 * not just the ones after it.
 */
export async function findSessionChainIds(sql: TenantQueryable, id: string): Promise<string[]> {
  const result = await sql.query<{ id: string }>(
    `WITH RECURSIVE
       ancestors AS (
         SELECT id, parent_session_id FROM auth_sessions WHERE id = $1
         UNION ALL
         SELECT s.id, s.parent_session_id
           FROM auth_sessions s
           JOIN ancestors a ON s.id = a.parent_session_id
       ),
       descendants AS (
         SELECT id, parent_session_id FROM auth_sessions WHERE id = $1
         UNION ALL
         SELECT s.id, s.parent_session_id
           FROM auth_sessions s
           JOIN descendants d ON s.parent_session_id = d.id
       )
     SELECT id FROM ancestors
     UNION
     SELECT id FROM descendants`,
    [id],
  );
  return result.rows.map((row) => row.id);
}

export interface InsertReuseDetectedAuditLogInput {
  userId: string;
  /** `null` when the user's client could not be resolved - audit_logs.client_id is nullable by design. */
  clientId: string | null;
}

/** Inserts the one `audit_logs` row (action `'auth.refresh_reuse_detected'`) a reuse-detection sweep requires. */
export async function insertReuseDetectedAuditLog(
  sql: TenantQueryable,
  input: InsertReuseDetectedAuditLogInput,
): Promise<void> {
  await sql.query(
    `INSERT INTO audit_logs (client_id, actor_type, action, target_type, target_id)
     VALUES ($1, 'system', 'auth.refresh_reuse_detected', 'user', $2)`,
    [input.clientId, input.userId],
  );
}
