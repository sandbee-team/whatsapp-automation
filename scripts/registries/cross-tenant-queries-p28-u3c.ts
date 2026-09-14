import type { CrossTenantQueryEntry } from './cross-tenant-queries.js';

/**
 * cross-tenant-queries-p28-u3c.ts (P28 Unit U3c, impersonation) - the one
 * deliberately non-tenant-scoped span the impersonation lifecycle routes
 * need, split out of `cross-tenant-queries-p28.ts` (a sibling per-unit
 * module, same per-phase split idiom as P23/P25/P26/P28-admin).
 *
 * Same class as `cross-tenant-queries-p28.ts`'s `readTopupForDecision`
 * entry: the staff actor arrives with only a `grantId` (from the URL path),
 * not a tenant context, for `mint`/`elevate`/`revoke` - `loadGrantClientId`
 * is the ONE read that resolves `client_id` FROM the grant row, which then
 * supplies the tenant GUC `withStaffMutation` sets for every statement after
 * it. Reachable ONLY behind `INTERNAL_API_ENABLED` (default false, routes
 * absent not forbidden) plus the HMAC service token + CIDR allow-list gate
 * every `/internal/v1` route shares.
 */
export const CROSS_TENANT_QUERIES_P28_U3C: Record<string, CrossTenantQueryEntry> = Object.freeze({
  'app/backend/src/modules/internal/routes/impersonation-lifecycle-support.ts:loadGrantClientId': {
    role: 'staff via /internal/v1 (wp_admin_app, BYPASSRLS SELECT, SET LOCAL ROLE inside the request transaction - same shape as internal-access.ts#readTopupForDecision)',
    reason:
      'P28 U3c - reads ONE impersonation_grants row by its own primary key (grantId, the only identifier the mint/elevate/revoke routes have from the URL path) to resolve client_id BEFORE withStaffMutation opens - the row it returns is what supplies the tenant GUC every downstream statement in that transaction is then scoped to (same "resolve first, mutate tenant-scoped after" shape as readTopupForDecision). The mutation itself re-reads and FOR UPDATE-locks the same row a second time, scoped to BOTH grantId and the now-known clientId (impersonation-lifecycle-support.ts#lockGrantOrThrow) - this pre-read never itself writes.',
    projectedColumns: ['client_id'],
  },
});
