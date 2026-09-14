import type { CrossTenantQueryEntry } from './cross-tenant-queries.js';

/**
 * cross-tenant-queries-p28.ts (P28 admin-internal-api-and-panel) - the
 * `/internal/v1` STAFF surface's deliberately non-tenant-scoped spans, split
 * out of `cross-tenant-queries.ts` for that file's own `max-lines: 300` cap
 * (same per-phase split idiom as the P23/P25/P26 modules).
 *
 * FOUR of the five live in `modules/internal/internal-access.ts` and share
 * one gate: reachable ONLY behind `INTERNAL_API_ENABLED` (default false -
 * the routes are ABSENT, not merely forbidden), an HMAC service token bound
 * to the concrete request path, a CIDR allow-list, and a `staff_users` row
 * whose role passes `canStaff(role, action)`. Three of those are keyed on a
 * top-up request's own primary key (the staff actor arrives with the request
 * id and no tenant context - the row it reads is what SUPPLIES the
 * `client_id` every downstream money write is then scoped to); the fourth is
 * the review QUEUE, which is cross-tenant by definition.
 *
 * The FIFTH (P28 U3b, `pacing-overrides.repo.ts`) is not a request-path read
 * at all: it is the `ROLE=cron` admin-relax EXPIRY sweep, whose whole job is
 * fleet-wide by definition and which re-scopes every row it finds through
 * `tenantDb.withTenant` before touching anything.
 *
 * Keyed `<file>:<symbol>` exactly as `check-tenant-scope.ts` derives them.
 */
export const CROSS_TENANT_QUERIES_P28: Record<string, CrossTenantQueryEntry> = Object.freeze({
  'app/backend/src/modules/internal/internal-access.ts:readTopupsByStatus': {
    role: 'staff via /internal/v1 (wp_admin_app, BYPASSRLS SELECT, entered by SET LOCAL ROLE inside the request transaction - same shape as modules/events/relay-loop-role.ts#withRelayRole)',
    reason:
      'P19 U5 step 8 - the staff top-up review queue (GET /internal/v1/topups?status=pending) is cross-tenant BY DEFINITION: a human reviewing pending UPI/bank top-up submissions has no single client_id to scope to, and a tenant must never approve its own top-up (migration 0058 deliberately grants wp_app SELECT+INSERT only, no UPDATE). Reachable ONLY behind INTERNAL_API_ENABLED (default false, routes absent not forbidden) plus an HMAC service token and a CIDR allow-list. Ids, enums and paise only - no phone, email, body, contact name or wallet external_ref is projected or rendered. Superseded by P28, which replaces this stopgap with the full admin surface.',
    projectedColumns: ['id', 'client_id', 'amount_minor', 'status', 'created_at'],
  },
  'app/backend/src/modules/internal/internal-access.ts:readTopupForDecision': {
    role: 'staff via /internal/v1 (wp_admin_app, BYPASSRLS SELECT, SET LOCAL ROLE inside the request transaction)',
    reason:
      'P19 U5 step 8 - reads ONE topup_requests row by its own primary key FOR UPDATE, to approve or reject it. Keyed on the request id rather than client_id because the staff actor arrives with the request id and no tenant context; the row it returns is what supplies the client_id every downstream money write is then scoped to. FOR UPDATE serialises two concurrent approvers on the same request. Same flag/token/CIDR gate as readTopupsByStatus.',
    projectedColumns: ['id', 'client_id', 'amount_minor', 'status'],
  },
  'app/backend/src/modules/internal/internal-access.ts:readTopupAmountMinor': {
    role: 'staff via /internal/v1 (wp_app under the target tenant GUC, inside withStaffMutation transaction)',
    reason:
      'P28 U3a step 4 - reads the amount_minor of ONE topup_requests row by its own primary key, to fill the topup_rejected notification payload. Keyed on the request id rather than client_id for the same reason as readTopupForDecision: the staff actor arrives with the request id, and withStaffMutation has ALREADY set app.client_id to the client this request belongs to (resolved via readTopupForDecision before the mutation opened), so RLS on this table additionally confines the read to that one tenant - this is the narrowest of the internal topup reads, not a scan. Amount is returned as bigint, never through Number().',
    projectedColumns: ['amount_minor'],
  },
  'app/backend/src/modules/pacing/pacing-overrides.repo.ts:selectExpiredAdminRelaxOverrides': {
    role: 'ROLE=cron (the admin-relax expiry sweep, engine/pacing/admin-relax-expiry.ts, single-flighted on a pg advisory lock like every other cron cadence)',
    reason:
      "P28 U3b step 5 - an EXPIRY sweep has no single tenant to scope to by definition: it must find every instance_pacing_overrides row whose mandatory expires_at has elapsed, across the fleet, so the staff pacing relax it recorded can be walked back. This is what makes the write path's mandatory <=30-day expiry real rather than decorative (core invariant 6 / safety-compliance: a relax is a temporary, reasoned, audited loosening, never a permanent one). Bounded LIMIT 100 per tick and cadence-capped at 5 minutes (ADR 0018 S4), so it never scales with fleet size. Projects ONLY the three ids the caller needs to immediately re-scope each row through tenantDb.withTenant - no patch, reason, actor or timestamp crosses a tenant boundary, and every subsequent statement (the expiry_applied_at stamp and the updatePacingConfig re-resolve) runs tenant-scoped under RLS. The re-resolve direction is always a TIGHTENING back to the strict baseline.",
    projectedColumns: ['id', 'client_id', 'instance_id'],
  },
  'app/backend/src/modules/internal/internal-access.ts:markTopupDecided': {
    role: 'staff via /internal/v1 (wp_admin_app, column-scoped UPDATE grant from migration 0058, SET LOCAL ROLE inside the request transaction)',
    reason:
      'P19 U5 step 8 - flips ONE topup_requests row to approved/rejected, keyed on its own primary key inside the same transaction as the readTopupForDecision FOR UPDATE that produced it. Conditional on status = pending (state transitions via conditional UPDATE, .claude/rules/database.md). wp_app has NO UPDATE grant on this table at all, so this statement is unreachable from any tenant route - the grant snapshot is the mechanical proof.',
    projectedColumns: ['id'],
  },
});
