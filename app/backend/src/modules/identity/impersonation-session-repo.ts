import type { TenantQueryable } from '@wp/db';

/**
 * impersonation-session-repo.ts (P28 Unit U3c) - SQL ONLY (same discipline
 * as identity.repo.ts's own header), scoped to the ONE read the `/v1/auth/*`
 * side of impersonation needs: re-reading a grant by id (for `refresh` and
 * `me`) under the tenant GUC the caller's own transaction already set. The
 * WRITE side (grant/mint/elevate/revoke) lives in `modules/internal` - this
 * file is deliberately read-only.
 */

export interface ImpersonationGrantRow {
  id: string;
  clientId: string;
  staffId: string;
  targetUserId: string | null;
  scope: 'metadata_only' | 'with_message_bodies';
  expiresAt: Date;
  revokedAt: Date | null;
}

interface RawGrantRow extends Record<string, unknown> {
  id: string;
  client_id: string;
  staff_id: string;
  target_user_id: string | null;
  scope: 'metadata_only' | 'with_message_bodies';
  expires_at: Date;
  revoked_at: Date | null;
}

function mapGrantRow(row: RawGrantRow): ImpersonationGrantRow {
  return {
    id: row.id,
    clientId: row.client_id,
    staffId: row.staff_id,
    targetUserId: row.target_user_id,
    scope: row.scope,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/** Reads ONE `impersonation_grants` row by id, scoped to `clientId` (RLS also enforces this - the explicit predicate keeps the query self-documenting). `undefined` for a missing/foreign-tenant grant. */
export async function findImpersonationGrant(
  sql: TenantQueryable,
  clientId: string,
  grantId: string,
): Promise<ImpersonationGrantRow | undefined> {
  const result = await sql.query<RawGrantRow>(
    `SELECT id, client_id, staff_id, target_user_id, scope, expires_at, revoked_at
       FROM impersonation_grants
      WHERE id = $1 AND client_id = $2
      -- client_id = client_id = $2`,
    [grantId, clientId],
  );
  return result.rows[0] ? mapGrantRow(result.rows[0]) : undefined;
}

/** `staff_users.full_name` for `staffId` - never the staff email (safety-compliance: minimum data to the tenant). `null` if the row is gone. */
export async function staffLabelFor(sql: TenantQueryable, staffId: string): Promise<string | null> {
  const result = await sql.query<{ full_name: string }>(
    `SELECT full_name FROM staff_users WHERE id = $1`,
    [staffId],
  );
  return result.rows[0]?.full_name ?? null;
}
