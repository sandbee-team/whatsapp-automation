import type { CrossTenantQueryEntry } from './cross-tenant-queries.js';

/**
 * cross-tenant-queries-p28-admin-detail.ts (P28 Unit U4, step 7) - the
 * admin-backend PER-CLIENT detail reads. Each is keyed on one `client_id`
 * (or, for `readClient`, one client primary key) rather than scanning: they
 * are registered here not because they span tenants but because they run as
 * `wp_admin_app` (BYPASSRLS), so RLS is not what confines them - the
 * `WHERE client_id = $1` predicate in the statement is, and the registry is
 * where that narrowness is reviewed.
 *
 * The shared gate, projection discipline and audit guarantee that apply to
 * every entry are documented once, in the parent
 * `cross-tenant-queries-p28-admin.ts`.
 */
export const CROSS_TENANT_QUERIES_P28_ADMIN_DETAIL_READS: Record<string, CrossTenantQueryEntry> =
  Object.freeze({
    'admin/backend/src/modules/clients/clients.read.ts:readClient': {
      role: 'wp_admin_app',
      reason:
        'ONE client row by primary key - the client-detail header. Keyed on the client id a staff member navigated to from the list; returns undefined for a deleted or unknown workspace rather than a partial view. No owner name/email/phone (the clients row has no such column; owner_user_id is deliberately not resolved to a person here).',
      projectedColumns: [
        'id',
        'company_name',
        'slug',
        'status',
        'onboarding_step',
        'timezone',
        'created_at',
        'plan_key',
        'plan_name',
      ],
    },
    'admin/backend/src/modules/instances/instances.read.ts:listClientInstances': {
      role: 'wp_admin_app',
      reason:
        "ONE client's live instances (the client-detail instance panel), WHERE client_id = $1 and hard-capped by an explicit LIMIT - bounded by construction since a workspace's instance count is capped by its plan. Same projection as the fleet list (states, pause reason, band/tier, lease owner/freshness, queue depth and oldest-queued age) and the same exclusions: no phone_e164, owner_jid or label.",
      projectedColumns: [
        'id',
        'client_id',
        'health_state',
        'link_state',
        'desired_state',
        'pause_reason',
        'created_at',
        'band',
        'tier',
        'owner_worker_id',
        'lease_seen_at',
        'queue_depth',
        'oldest_queued_age_seconds',
      ],
    },
    'admin/backend/src/modules/wallet/wallet.read.ts:readWalletAccount': {
      role: 'wp_admin_app',
      reason:
        "ONE client's wallet header by primary key (state, currency, balance, the per-message rate ceiling and the low-balance threshold) - what a staff member needs before deciding on a credit, adjustment or freeze. Every paise amount is projected as ::text and parsed as a decimal string, never through Number(): these are bigint columns holding real money, and a float round-trip past 2^53 paise would silently corrupt them.",
      projectedColumns: [
        'client_id',
        'state',
        'currency',
        'balance_minor',
        'max_rate_minor',
        'low_balance_threshold_minor',
        'updated_at',
      ],
    },
    'admin/backend/src/modules/wallet/wallet.read.ts:listWalletLedger': {
      role: 'wp_admin_app',
      reason:
        "ONE client's wallet ledger, newest first, WHERE client_id = $1, keyset-paginated on (created_at, seq) - seq is the table's own per-client monotonic sequence, so that tuple is strictly ordered and unique within a client (a bare timestamp is not: two same-transaction entries share it). Projects NEITHER external_ref NOR reason: external_ref is a payment identifier tying a bank transaction to a named person, and reason is unstructured free text, which is exactly where PII accumulates. The staff-side trail for ledger changes lives in staff_audit_log instead, keyed to the staff member who wrote it.",
      projectedColumns: [
        'seq',
        'kind',
        'amount_minor',
        'balance_after_minor',
        'actor_type',
        'created_at',
      ],
    },
    'admin/backend/src/modules/wallet/wallet.read.ts:readClientPricing': {
      role: 'wp_admin_app',
      reason:
        "ONE client's price list key plus its staff-set override map by primary key - the client-detail pricing block, and the value a superadmin reads before changing pricing (the change itself is a /internal/v1 mutation proxied through app-backend, never a write from here).",
      projectedColumns: ['price_list_key', 'override_items'],
    },
    'admin/backend/src/modules/plans/plans.read.ts:readClientLimits': {
      role: 'wp_admin_app',
      reason:
        "ONE client's effective limit picture: its plan's limits (joined via clients.plan_id) plus every client_limit_overrides row for that client_id. The two halves are returned SEPARATELY, never pre-merged, so the panel can show that a value is a human-set override rather than the plan default - a merged number would hide the fact that someone widened a limit, which is precisely what a staff reviewer needs to see.",
      projectedColumns: [
        'key',
        'name',
        'max_connected_instances',
        'max_registered_instances',
        'max_broadcast_recipients',
        'limit_key',
        'limit_value',
        'expires_at',
      ],
    },
    'admin/backend/src/modules/audit/audit.read.ts:listRecentClientStaffActions': {
      role: 'wp_admin_app',
      reason:
        "ONE client's most recent staff actions (the client-detail recentStaffActions block), WHERE client_id = $1 with an explicit LIMIT. Same projection and same `reason`-is-staff-text rationale as listStaffAudit above.",
      projectedColumns: [
        'id',
        'staff_id',
        'action',
        'client_id',
        'target_kind',
        'target_ref',
        'reason',
        'created_at',
      ],
    },
    'admin/backend/src/modules/audit/audit.read.ts:listActiveImpersonations': {
      role: 'wp_admin_app',
      reason:
        "ONE client's currently-live impersonation grants (neither revoked nor expired), WHERE client_id = $1 with an explicit LIMIT. Surfaced on the client-detail page on purpose: a staff member about to act on a workspace should be able to see that a colleague is inside it right now. Projects the grant's own scope/reason/expiry, never any tenant data the grant would give access to.",
      projectedColumns: ['id', 'staff_id', 'scope', 'reason', 'created_at', 'expires_at'],
    },
  });
