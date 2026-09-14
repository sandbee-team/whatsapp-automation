import type { FastifyRequest } from 'fastify';
import {
  StaffUnauthenticatedError,
  verifyStaffAccessToken,
} from '../../modules/staff-auth/tokens.js';
import { findStaffUserById } from '../../modules/staff-auth/sessions.js';
import { withStaffRoleTx, type AdminReadPool } from '../platform-read.js';
import type { AdminStaffContext } from './route-policy.js';

/**
 * platform/http/staff-auth-plugin.ts (P28 Unit U4, step 6) - the bearer
 * access-token primitive `route-policy.ts`'s `'staff'` policy builds on.
 * NO FALLBACK IDENTITY anywhere: a missing or invalid `Authorization` header
 * on a staff route always throws `StaffUnauthenticatedError` and never
 * substitutes a default staff member.
 *
 * TWO checks per request, not one:
 *  1. the JWT's own signature/expiry (`jose`), which bounds a stolen token
 *     to at most 120 seconds; and
 *  2. ONE `staff_users` SELECT comparing the token's `epoch` claim against
 *     the CURRENT `token_epoch`, and re-checking `status = 'active'`.
 *
 * The second is what makes revocation immediate rather than eventual: an
 * operator disabling an account (or the refresh-reuse sweep) bumps
 * `token_epoch`, and every outstanding token dies on its very next request
 * with no deny-list to maintain and no cache to invalidate. It costs one
 * indexed primary-key read per request, which for a handful of staff is
 * free - deliberately NOT cached (app-backend caches the tenant equivalent
 * in Redis because it serves tenant traffic volumes; admin-backend has no
 * Redis dependency and no such volume, so the authoritative read is
 * simply always taken).
 */

export interface StaffAuthDeps {
  pool: AdminReadPool;
  jwtSecret: string;
  now: () => Date;
}

function extractBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/** Authenticates `req`, or throws `StaffUnauthenticatedError` - never a fallback identity. */
export async function authenticateStaff(
  deps: StaffAuthDeps,
  req: FastifyRequest,
): Promise<AdminStaffContext> {
  const token = extractBearerToken(req);
  if (!token) {
    throw new StaffUnauthenticatedError();
  }

  const claims = await verifyStaffAccessToken({
    secret: deps.jwtSecret,
    token,
    now: deps.now(),
  });

  const staff = await withStaffRoleTx(deps.pool, (db) => findStaffUserById(db, claims.staffId));
  if (!staff || staff.status !== 'active' || staff.tokenEpoch !== claims.epoch) {
    // One undistinguished error for all three: a caller must not be able to
    // tell "your session was revoked" from "that account is disabled" from
    // "no such staff id".
    throw new StaffUnauthenticatedError();
  }

  return { staffId: staff.id, role: staff.role, fullName: staff.fullName };
}
