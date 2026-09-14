import type { StaffRole } from '@wp/domain';
import { canStaff, type StaffAction } from '@wp/domain';
import { parseActorHeader } from '@wp/contracts';
import type { AdminAppQueryable } from './staff-audit.js';

/**
 * actor.ts (P28 Unit U3a, step 4) - resolves the `X-Actor` header into a
 * `StaffActor` and re-checks its RBAC permission server-side. Every
 * `/internal/v1` mutation calls `resolveStaffActor` then `assertStaffCan`
 * INSIDE `withStaffMutation`'s own transaction (`with-staff-mutation.ts`),
 * on the SAME `wp_app` connection the mutation itself runs on - never a
 * second pool checkout.
 *
 * A `StaffActor` is DELIBERATELY never a `TenantContext`
 * (`platform/http/route-policy.ts`'s `AuthenticatedContext`) - a staff
 * member acting on `/internal/v1` is never "logged in as" a tenant; mixing
 * the two types would let a staff mutation accidentally reuse tenant-session
 * authorization logic that assumes a `clientId`-scoped human user.
 */

export interface StaffActor {
  kind: 'staff';
  staffId: string;
  role: StaffRole;
  label: string;
}

export class InternalForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(message = 'This staff account may not perform this action.') {
    super(message);
    this.name = 'InternalForbiddenError';
  }
}

interface StaffUserRow extends Record<string, unknown> {
  id: string;
  role: StaffRole;
  status: string;
  full_name: string;
}

/**
 * Parses `X-Actor` (anything but `staff:<uuid>` -> 403, never a 400 - the
 * header shape itself is validated earlier by `internalMutationHeadersSchema`
 * at the route boundary; a well-formed-but-wrong actor kind is an
 * authorization failure, not a validation one) then loads the staff row on
 * `db` (the mutation's own `wp_app` connection - the column grant
 * `SELECT (id, role, status, full_name) ON staff_users TO wp_app`, migration
 * 0070, exists for exactly this read). Unknown id or `status <> 'active'` ->
 * 403, same undistinguished `InternalForbiddenError` (never leaks WHICH
 * check failed to the caller).
 */
export async function resolveStaffActor(
  db: AdminAppQueryable,
  header: string,
): Promise<StaffActor> {
  let staffId: string;
  try {
    staffId = parseActorHeader(header).staffId;
  } catch {
    throw new InternalForbiddenError();
  }

  const result = await db.query<StaffUserRow>(
    `SELECT id, role, status, full_name FROM staff_users WHERE id = $1`,
    [staffId],
  );
  const row = result.rows[0];
  if (!row || row.status !== 'active') {
    throw new InternalForbiddenError();
  }

  return { kind: 'staff', staffId: row.id, role: row.role, label: row.full_name };
}

/** Server-side RBAC re-check (never trust what the admin panel greys out) - throws `InternalForbiddenError` (403 `FORBIDDEN`) when `actor.role` may not perform `action`. */
export function assertStaffCan(actor: StaffActor, action: StaffAction): void {
  if (!canStaff(actor.role, action)) {
    throw new InternalForbiddenError();
  }
}
