import type { FastifyRequest } from 'fastify';
import { withAdminAppRole } from '../staff-audit.js';
import { InternalTargetNotFoundError } from './internal-errors.js';
import type { StaffMutationTx } from '../with-staff-mutation.js';
import type { InternalRoutesDeps } from '../internal-routes-deps.js';

/**
 * routes/impersonation-lifecycle-support.ts (P28 Unit U3c) - the row shapes
 * and pre-read helpers `impersonation-mint.ts`/`impersonation-elevate.ts`/
 * `impersonation-revoke-list.ts` all share (300-line cap split of a single
 * combined file - see `impersonation.ts`'s own module doc for the full
 * "grantId-addressed, resolve clientId first" rationale). NOT a route file
 * itself.
 */

export const CODE_CHECK_VIOLATION = '23514';

export function isCheckViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === CODE_CHECK_VIOLATION
  );
}

/** The `impersonation_grants.client_id` for `grantId`, read under `wp_admin_app` BEFORE `withStaffMutation` - the tenant GUC it needs is not known from the path alone (same pre-read shape as `routes/topups.ts`'s approve/reject). `undefined` for a missing grant. */
export async function loadGrantClientId(
  deps: InternalRoutesDeps,
  grantId: string,
): Promise<string | undefined> {
  return withAdminAppRole(deps.pool, async (db) => {
    const result = await db.query<{ client_id: string }>(
      `SELECT client_id FROM impersonation_grants WHERE id = $1`,
      [grantId],
    );
    return result.rows[0]?.client_id;
  });
}

export interface GrantStateRow extends Record<string, unknown> {
  id: string;
  staff_id: string;
  target_user_id: string | null;
  scope: 'metadata_only' | 'with_message_bodies';
  expires_at: Date;
  revoked_at: Date | null;
  parent_grant_id: string | null;
}

/** Locks the grant row (scoped to BOTH ids), throws 404 for a missing/foreign-tenant grant. */
export async function lockGrantOrThrow(
  tx: StaffMutationTx,
  clientId: string,
  grantId: string,
): Promise<GrantStateRow> {
  const result = await tx.query<GrantStateRow>(
    `SELECT id, staff_id, target_user_id, scope, expires_at, revoked_at, parent_grant_id
       FROM impersonation_grants
      WHERE id = $1 AND client_id = $2
      -- client_id = $2
      FOR UPDATE`,
    [grantId, clientId],
  );
  const row = result.rows[0];
  if (!row) throw new InternalTargetNotFoundError('No such impersonation grant for this client.');
  return row;
}

export function grantIdFrom(req: FastifyRequest): string {
  return (req.params as { grantId: string }).grantId;
}
