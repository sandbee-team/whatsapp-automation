import type { AdminReadQueryable } from '../../platform/platform-read.js';
import { decodeCursor, encodeCursor, type KeysetPage } from '../../platform/keyset.js';

/**
 * modules/audit/audit.read.ts (P28 Unit U4, step 7) - the staff audit trail
 * (`staff_audit_log`): what staff did, to which workspace, why, and whether
 * it took effect. Cross-tenant by definition (a staff member's action
 * history spans every workspace they touched), filterable by client, staff
 * member and action.
 *
 * `reason` IS projected here, unlike everywhere else in this project. It is
 * text a STAFF member typed to justify their own action, and reading it back
 * is the entire point of an audit trail - without it the log records that
 * someone suspended a workspace but not why, which is useless for the
 * accountability this table exists to provide. `target_ref` is likewise an
 * opaque id string (a topup/instance/campaign id), never a phone number or
 * an email.
 */

export interface StaffAuditItem {
  id: string;
  staffId: string;
  action: string;
  clientId: string | null;
  targetKind: string | null;
  targetRef: string | null;
  reason: string;
  createdAt: string;
}

const LIST_AUDIT_SQL = `SELECT id::text AS id,
         staff_id,
         action,
         client_id,
         target_kind,
         target_ref,
         reason,
         created_at
    FROM staff_audit_log
   WHERE ($1::uuid IS NULL OR client_id = $1)
     AND ($2::uuid IS NULL OR staff_id = $2)
     AND ($3::text IS NULL OR action = $3)
     AND ($4::timestamptz IS NULL OR (created_at, id) < ($4, $5::bigint))
   ORDER BY created_at DESC, id DESC
   LIMIT $6`;

interface RawAuditRow extends Record<string, unknown> {
  id: string;
  staff_id: string;
  action: string;
  client_id: string | null;
  target_kind: string | null;
  target_ref: string | null;
  reason: string;
  created_at: Date;
}

export interface ListStaffAuditFilter {
  clientId?: string;
  staffId?: string;
  action?: string;
  limit: number;
  cursor?: string;
}

function mapAuditRow(row: RawAuditRow): StaffAuditItem {
  return {
    id: row.id,
    staffId: row.staff_id,
    action: row.action,
    clientId: row.client_id,
    targetKind: row.target_kind,
    targetRef: row.target_ref,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  };
}

/** Keyset-paginated staff audit trail (see module header for why `reason` is projected). */
export async function listStaffAudit(
  db: AdminReadQueryable,
  filter: ListStaffAuditFilter,
): Promise<KeysetPage<StaffAuditItem>> {
  const cursor = decodeCursor(filter.cursor);
  const result = await db.query<RawAuditRow>(LIST_AUDIT_SQL, [
    filter.clientId ?? null,
    filter.staffId ?? null,
    filter.action ?? null,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    filter.limit,
  ]);
  const last = result.rows[result.rows.length - 1];
  return {
    items: result.rows.map(mapAuditRow),
    nextCursor:
      result.rows.length === filter.limit && last
        ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id })
        : null,
  };
}

const RECENT_CLIENT_ACTIONS_SQL = `SELECT id::text AS id,
         staff_id, action, client_id, target_kind, target_ref, reason, created_at
    FROM staff_audit_log
   WHERE client_id = $1
   ORDER BY created_at DESC, id DESC
   LIMIT $2`;

/** The client-detail view's `recentStaffActions` block - ONE client's most recent staff actions, hard-capped by `limit`. */
export async function listRecentClientStaffActions(
  db: AdminReadQueryable,
  clientId: string,
  limit: number,
): Promise<StaffAuditItem[]> {
  const result = await db.query<RawAuditRow>(RECENT_CLIENT_ACTIONS_SQL, [clientId, limit]);
  return result.rows.map(mapAuditRow);
}

export interface ImpersonationGrantView {
  id: string;
  staffId: string;
  scope: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
}

const ACTIVE_IMPERSONATIONS_SQL = `SELECT id, staff_id, scope::text AS scope, reason, created_at, expires_at
    FROM impersonation_grants
   WHERE client_id = $1 AND revoked_at IS NULL AND expires_at > now()
   ORDER BY expires_at DESC
   LIMIT $2`;

/**
 * The client-detail view's `activeImpersonations` block: grants against this
 * workspace that are neither revoked nor expired. Surfaced on the DETAIL
 * page on purpose - a staff member about to act on a workspace should see
 * that a colleague is currently inside it.
 */
export async function listActiveImpersonations(
  db: AdminReadQueryable,
  clientId: string,
  limit: number,
): Promise<ImpersonationGrantView[]> {
  const result = await db.query<{
    id: string;
    staff_id: string;
    scope: string;
    reason: string;
    created_at: Date;
    expires_at: Date;
  }>(ACTIVE_IMPERSONATIONS_SQL, [clientId, limit]);
  return result.rows.map((row) => ({
    id: row.id,
    staffId: row.staff_id,
    scope: row.scope,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  }));
}
