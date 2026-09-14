import type { CrossTenantQueryEntry } from './cross-tenant-queries.js';
import { CROSS_TENANT_QUERIES_P28_ADMIN_DETAIL_READS } from './cross-tenant-queries-p28-admin-detail.js';

/**
 * cross-tenant-queries-p28-admin-reads.ts (P28 Unit U4, step 7) - the
 * admin-backend LIST reads. The shared gate, projection discipline and
 * rationale that apply to EVERY entry here are documented once, in the
 * parent `cross-tenant-queries-p28-admin.ts`; each `reason` below states
 * only what is specific to that one query. The per-client DETAIL reads live
 * in the sibling `-detail.ts` module (max-lines split).
 */
export const CROSS_TENANT_QUERIES_P28_ADMIN_READS: Record<string, CrossTenantQueryEntry> =
  Object.freeze({
    'admin/backend/src/modules/clients/clients.read.ts:listClients': {
      role: 'wp_admin_app',
      reason:
        'The staff client list is cross-tenant by definition: it is the entry point to every support and billing action, and a staff member arrives with a company name or a ticket, not a client_id. Keyset-paginated on (created_at, id) - never OFFSET, which over a table the live send path is writing would silently skip and duplicate workspaces. Instance/connected counts are correlated COUNT subqueries (no per-instance row leaves this query); balance is paise as ::text, never Number(). Projects company_name and slug - a workspace business identity, not a natural person - and no owner name, email or phone.',
      projectedColumns: [
        'id',
        'company_name',
        'slug',
        'status',
        'onboarding_step',
        'plan_key',
        'created_at',
        'instance_count',
        'connected_count',
        'wallet_state',
        'balance_minor',
      ],
    },
    'admin/backend/src/modules/instances/instances.read.ts:listInstances': {
      role: 'wp_admin_app',
      reason:
        'The fleet instance list - cross-tenant so an operator can answer "which instances are degraded/paused right now" across the platform (optionally narrowed to one health state and/or one client). Keyset-paginated on (created_at, id). Projects STATES, pause reason, pacing band/tier, lease owner + freshness, and queued depth/oldest-age - everything needed to diagnose a stuck session - but deliberately NOT phone_e164, owner_jid or label: staff never need the tenant\'s WhatsApp number to act on its state, and putting it on a routine ops list would make every staff session a standing PII disclosure.',
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
    'admin/backend/src/modules/queue/queue.read.ts:readQueueSummary': {
      role: 'wp_admin_app',
      reason:
        'The fleet queue summary - COUNTS ONLY (jobs grouped by message_jobs.status, live instances grouped by health_state, and the unowned-instance count), so it projects no per-row tenant data at all and is the narrowest cross-tenant read in this project by construction. The unowned predicate is copied from db/queries/fleet-gauges.sql verbatim (same LEFT JOIN shape, same 45-second lease-staleness window) so a staff member and the wp_instances_unowned gauge can never disagree about what "unowned" means.',
      projectedColumns: ['status', 'health_state', 'count'],
    },
    'admin/backend/src/modules/topups/topups.read.ts:listTopups': {
      role: 'wp_admin_app',
      reason:
        "The top-up review queue - cross-tenant by definition (a reviewer of pending UPI/bank submissions has no single client_id to scope to, and migration 0058 deliberately gives wp_app no UPDATE grant at all so a tenant can never approve its own top-up). Keyset-paginated. Projects amount/method/status/age but NOT external_ref: that UTR identifies a real bank transaction against a named person and belongs to the moment one specific request is decided (through app-backend's audited /internal/v1 staff-mutation transaction), not to a queue browse.",
      projectedColumns: ['id', 'client_id', 'amount_minor', 'method', 'status', 'created_at'],
    },
    'admin/backend/src/modules/audit/audit.read.ts:listStaffAudit': {
      role: 'wp_admin_app',
      reason:
        "The staff audit trail (staff_audit_log) - cross-tenant because a staff member's action history spans every workspace they touched; filterable by client, staff member and action, keyset-paginated on (created_at, id). This is the ONE read that projects `reason`, and deliberately so: it is text a STAFF member typed to justify their own action, and reading it back is the entire point of an audit trail - without it the log shows that someone suspended a workspace but not why. target_ref is an opaque id string (topup/instance/campaign), never a phone number or email.",
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
    'admin/backend/src/modules/plans/plans.read.ts:listPlans': {
      role: 'wp_admin_app',
      reason:
        'The plan catalogue with its limits. plans/plan_limits are PLATFORM catalogue tables carrying no client_id at all, so this read crosses no tenant boundary; it still runs through platformRead() like everything else so an operator can answer "who looked at what, when" without first having to reason about which tables happen to be tenant-scoped. Small and bounded (three seeded plans), hence no pagination.',
      projectedColumns: [
        'id',
        'key',
        'name',
        'description',
        'is_default',
        'max_connected_instances',
        'max_registered_instances',
        'max_broadcast_recipients',
      ],
    },
    ...CROSS_TENANT_QUERIES_P28_ADMIN_DETAIL_READS,
  });
