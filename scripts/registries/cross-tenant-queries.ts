import { CROSS_TENANT_QUERIES_P23 } from './cross-tenant-queries-p23.js';
import { CROSS_TENANT_QUERIES_P25 } from './cross-tenant-queries-p25.js';
import { CROSS_TENANT_QUERIES_P26 } from './cross-tenant-queries-p26.js';
import { CROSS_TENANT_QUERIES_P28 } from './cross-tenant-queries-p28.js';
import { CROSS_TENANT_QUERIES_P28_ADMIN } from './cross-tenant-queries-p28-admin.js';
import { CROSS_TENANT_QUERIES_P28_U3C } from './cross-tenant-queries-p28-u3c.js';

/**
 * The tenant-scope exemption registry (P00 step 6, `scripts/check-tenant-scope.ts`).
 *
 * Keyed `"<repo-relative-file>:<exported-symbol>"`. An entry here is the
 * ONLY legal way to run a query against a table in `TENANT_TABLES`
 * (`scripts/check-tenant-scope.ts`) without a `client_id` predicate in the
 * same statement. Every entry needs a non-empty `role`, `reason` and
 * `projectedColumns` list - an entry missing any of the three is itself a
 * violation. Each entry is reviewed individually on its own merits; this
 * registry is never a blanket exemption.
 *
 * The discovery loop, scheduler worklist, reaper, retention sweep and admin
 * reads that legitimately need to read across tenants register queries here.
 * The P23 epoch-sweep/cancel-bookkeeping entries live in the sibling
 * `cross-tenant-queries-p23.ts` (max-lines split) and are spread into
 * `CROSS_TENANT_QUERIES` below - same registry, same review discipline.
 */

export interface CrossTenantQueryEntry {
  /** Who/what runs this query (e.g. "scheduler", "reaper", "admin-read"). */
  role: string;
  /** Why this query must legitimately cross tenant boundaries. */
  reason: string;
  /** Exactly which columns the query projects - keeps the exemption narrow. */
  projectedColumns: string[];
}

export const CROSS_TENANT_QUERIES: Record<string, CrossTenantQueryEntry> = Object.freeze({
  'db/queries/lease-renew-batch.sql:lease-renew-batch': {
    role: 'worker (wp_app; lease_owner_renew RLS policy scoped to app.worker_id — ADR 0029)',
    reason:
      'one batched lease-liveness renew per worker per tick across every lease it holds (ADR 0018 §4, scope-delta row 2); rows are bounded by owner_worker_id + fence predicates in the statement AND by the policy',
    projectedColumns: ['instance_id'],
  },
  'db/queries/lease-scan-unowned.sql:lease-scan-unowned': {
    role: 'wp_scheduler',
    reason:
      'cross-tenant discovery of unowned online instances (worker fleet lease-grab); executes through the read-only SECURITY DEFINER wp_lease_scan_unowned owned by wp_admin_app (ADR 0029)',
    projectedColumns: ['instance_id', 'client_id'],
  },
  'db/queries/discover-instances.sql:discover-instances': {
    role: 'wp_scheduler',
    reason:
      'P09 fleet-wide discovery loop (engine/fleet/discovery.ts), wired into roles/session-worker.ts via engine/session/session-worker-composition.ts - cross-tenant scan of unowned, online instances eligible for lease grab, executed through the existing read-only SECURITY DEFINER wp_lease_scan_unowned (migration 0018/0019, ADR 0029); replaces the retired P08 narrow pairing-intent bootstrapScan entry (formerly "app/backend/src/roles/session-worker.ts:bootstrapScan", removed P09 U6 step 9 now that this entry covers the same worker role end-to-end)',
    projectedColumns: ['instance_id', 'client_id'],
  },
  'db/queries/fleet-gauges.sql:fleet-gauges': {
    role: 'wp_scheduler',
    reason:
      'P09 fleet-capacity gauges (wp_instances_unowned / wp_fleet_capacity_headroom) - cross-tenant COUNT-only aggregate of unowned and desired-online instances (blueprint [R-37]); returns counts, never per-row instance/client data',
    projectedColumns: ['unowned_count', 'desired_online_count'],
  },
  'db/queries/claim-outbox.sql:claim-outbox': {
    role: 'wp_relay (NOLOGIN BYPASSRLS, migration 0041)',
    reason:
      'P15 relay drain: cross-tenant SKIP LOCKED claim of unpublished outbox rows, bounded LIMIT 500 per 500 ms tick, oldest-first; safe with N relay processes (proof: two_relay_processes_publish_each_event_exactly_once)',
    projectedColumns: [
      'id',
      'client_id',
      'instance_id',
      'event_type',
      'entity_id',
      'payload',
      'coalesce_key',
      'fanout',
      'attempts',
    ],
  },
  'app/backend/src/modules/events/relay-loop.ts:drainOnce': {
    role: 'wp_relay (NOLOGIN BYPASSRLS, migration 0041)',
    reason:
      'P15 relay drain loop: cross-tenant depth gauge (COUNT-only) and mark-published/suppressed_by UPDATEs by claimed id set - the write half of the claim-outbox exemption above, bounded to the ids the SKIP LOCKED claim returned in the same tick',
    projectedColumns: ['depth', 'id'],
  },
  'app/backend/src/modules/events/cleanup.ts:runOutboxCleanup': {
    role: 'wp_relay (NOLOGIN BYPASSRLS, migration 0041)',
    reason:
      'P15 bounded outbox cleanup: cross-tenant DELETE of rows published more than an hour ago, capped at 5000 per tick via WHERE id IN (SELECT ... LIMIT 5000); unpublished rows are structurally untouchable (proof: cleanup_deletes_only_published_rows_and_is_bounded)',
    projectedColumns: ['id'],
  },
  'db/queries/reap-expired-leases.sql:reap-expired-leases': {
    role: 'wp_scheduler',
    reason:
      'cross-tenant lease-expiry sweep across every tenant in one pass (blueprint reaper); executes through the SECURITY DEFINER wp_reap_expired_leases owned by wp_reaper',
    projectedColumns: [
      'client_id',
      'instance_id',
      'message_job_id',
      'message_job_created_at',
      'new_status',
      'attempt_state',
      'send_attempt_id',
      'send_attempt_no',
    ],
  },
  'db/queries/reconcile-unresolved.sql:reconcile-unresolved': {
    role: 'wp_scheduler',
    reason:
      'P12 echo reconciler (modules/queue/reconciler.ts, step 6) - cross-tenant read of needs_reconcile jobs and their in-flight send_attempts evidence, executed through the read-only SECURITY DEFINER wp_reconcile_scan_unresolved (migration 0027, C12 correction: wp_scheduler is not BYPASSRLS and sees zero rows on a bare cross-tenant SELECT against FORCE-RLS message_jobs/send_attempts); every write the reconciler makes stays on the normal per-tenant tenantDb.withTenant path, never this function',
    projectedColumns: [
      'client_id',
      'instance_id',
      'message_job_id',
      'message_job_created_at',
      'unresolved_at',
      'send_attempt_id',
      'send_attempt_no',
      'content_hash',
      'dispatched_at',
      'sibling_inflight_count',
    ],
  },
  'app/backend/src/engine/pacing/provision.ts:assertNoLiveInstanceIsMissingPacingState': {
    role: 'boot gate (wp_admin_app, BYPASSRLS)',
    reason:
      'P13 Unit U3 - cross-tenant boot-time scan proving every live (deleted_at IS NULL) instance has a materialised instance_pacing_state row with no NULL eff_* column before serving traffic, same class as the historical assertNoZeroMaxRateWallet boot gate: a non-BYPASSRLS role with no app.client_id GUC set would see zero rows and this gate would silently pass, so it must run unscoped across every tenant in one pass',
    projectedColumns: ['instance_id', 'reason'],
  },
  'app/backend/src/modules/webhooks/repo.ts:claimDueDeliveries': {
    role: 'wp_relay (NOLOGIN BYPASSRLS, migration 0041/0042)',
    reason:
      "P15 U5 webhook dispatcher loop (dispatcher.ts, withRelayRole/SET LOCAL ROLE wp_relay): cross-tenant SKIP LOCKED claim of due webhook_deliveries joined to their owning endpoint and source outbox_events payload, bounded LIMIT $1 oldest-due-first, on the dispatcher's own tick (a separate SET LOCAL ROLE wp_relay transaction from the relay drain loop's claim-outbox.sql entry above)",
    projectedColumns: [
      'id',
      'client_id',
      'endpoint_id',
      'outbox_event_id',
      'event_type',
      'attempt',
      'url',
      'secret_enc',
      'payload',
    ],
  },
  'app/backend/src/modules/webhooks/repo.ts:markDeliverySent': {
    role: 'wp_relay (NOLOGIN BYPASSRLS, migration 0041/0042)',
    reason:
      "P15 U5 dispatcher: marks one webhook_deliveries row sent by id already returned from the same tick's claimDueDeliveries SKIP LOCKED claim above - a primary-key update on a row the dispatcher already holds cross-tenant, not a fresh unscoped scan",
    projectedColumns: ['id'],
  },
  'app/backend/src/modules/webhooks/repo.ts:scheduleDeliveryRetry': {
    role: 'wp_relay (NOLOGIN BYPASSRLS, migration 0041/0042)',
    reason:
      "P15 U5 dispatcher: schedules the next retry on one webhook_deliveries row by id already returned from the same tick's claimDueDeliveries SKIP LOCKED claim above - a primary-key update on a row the dispatcher already holds cross-tenant",
    projectedColumns: ['id'],
  },
  'app/backend/src/modules/webhooks/repo.ts:markDeliveryFailed': {
    role: 'wp_relay (NOLOGIN BYPASSRLS, migration 0041/0042)',
    reason:
      "P15 U5 dispatcher: marks one webhook_deliveries row terminally failed by id already returned from the same tick's claimDueDeliveries SKIP LOCKED claim above - a primary-key update on a row the dispatcher already holds cross-tenant",
    projectedColumns: ['id'],
  },
  'app/backend/src/modules/webhooks/repo.ts:recordEndpointSuccess': {
    role: 'wp_relay (NOLOGIN BYPASSRLS, migration 0041/0042)',
    reason:
      "P15 U5 dispatcher health tracking: resets consecutive_failures on one webhook_endpoints row by id already known from the same tick's claimed delivery (endpoint_id) - a primary-key update on a row the dispatcher already holds cross-tenant",
    projectedColumns: ['id'],
  },
  'app/backend/src/modules/webhooks/repo.ts:incrementEndpointFailures': {
    role: 'wp_relay (NOLOGIN BYPASSRLS, migration 0041/0042)',
    reason:
      "P15 U5 dispatcher health tracking: increments consecutive_failures on one webhook_endpoints row by id already known from the same tick's claimed delivery (endpoint_id) - a primary-key update on a row the dispatcher already holds cross-tenant",
    projectedColumns: ['id', 'consecutive_failures', 'enabled'],
  },
  'app/backend/src/modules/webhooks/repo.ts:disableEndpointForConsecutiveFailures': {
    role: 'wp_relay (NOLOGIN BYPASSRLS, migration 0041/0042)',
    reason:
      'P15 U5 dispatcher health tracking: disables one webhook_endpoints row by id once incrementEndpointFailures reports the consecutive-failure threshold crossed - a primary-key update on a row the dispatcher already holds cross-tenant, decided and issued by dispatcher.ts',
    projectedColumns: ['id'],
  },
  'app/backend/src/engine/pacing/warmup-evaluator.ts:runOnePacingEvaluatorSweep': {
    role: 'wp_scheduler (5-minute pacing-evaluator cron loop, engine/cron/cron-wiring.ts)',
    reason:
      'P13a Unit U1 (FIX ROUND CRITICAL 1 correction) - bounded (LIMIT-capped, ORDER BY random() for fleet fairness) per-tick fleet-wide scan of due instances for warm-up-tier evaluation, executed through the read-only SECURITY DEFINER wp_warmup_scan_due (migration 0034, same class as wp_lease_scan_unowned/wp_reconcile_scan_unresolved - wp_scheduler is not BYPASSRLS and sees zero rows on a bare cross-tenant SELECT against FORCE-RLS instance_pacing_state/whatsapp_instances). Every downstream per-instance READ (hasRecentHardSignal/isDegradedRollbackDue/readSystemProfileLayer) is re-scoped per-row via tenantDb.withTenant(clientId, ...) under the real app.client_id GUC, never this function again. The per-instance WRITE (the tier-guarded UPDATE plus its audit_logs/pacing_events rows) goes through a SECOND SECURITY DEFINER function, wp_warmup_apply_tier_change (also migration 0034, owned by the new NOLOGIN/BYPASSRLS wp_warmup role, same narrow-scope shape as wp_reaper) - called from config-service.ts/config-service-warmup-write.ts via updatePacingConfig({kind:"warmup_tier"}), never directly from this file - so the entire guarded transition is one atomic definer-function body instead of unscoped statements on a bare pool.',
    projectedColumns: [
      'instance_id',
      'client_id',
      'pacing_timezone',
      'warmup_tier',
      'warmup_started_at',
      'health_band',
      'health_state',
    ],
  },
  'db/queries/health-samples-retention.sql:(module scope)': {
    role: "wp_scheduler (health-samples retention sweep, same login role as every other P16 health write path - migration 0045's own header)",
    reason:
      'P16 Unit A/E - bounded 30-day retention sweep for instance_health_samples (migration 0044), mirroring app/backend/src/modules/events/cleanup.ts#runOutboxCleanup exactly: cross-tenant DELETE of rows older than the caller-supplied retention window, capped at a caller-supplied per-tick limit via WHERE id IN (SELECT ... LIMIT $2) - never an unbounded cross-tenant statement. No .sql name marker exists in this file (Unit A left it unmarked), so this entry is keyed under "(module scope)" per check-tenant-scope.ts\'s own convention for an unmarked .sql file.',
    projectedColumns: ['id'],
  },
  'db/queries/wallet-reconcile.sql:wallet-reconcile-continuity': {
    role: 'wp_scheduler (cron; read-only SECURITY DEFINER owned by wp_admin_app, migration 0053)',
    reason:
      'P18 U8a wallet reconciler check A - cross-tenant scan of every wallet_accounts row for ledger continuity breaks, bounded to at most 200 wallet_ledger rows per client (LIMIT 200 inside the function body, never a full-ledger aggregate) plus p_limit clients per call, executed through wp_wallet_check_continuity (migration 0053) for the same reason wp_reconcile_scan_unresolved exists: wp_scheduler is not BYPASSRLS and sees zero rows on a bare cross-tenant SELECT against FORCE-RLS wallet_accounts/wallet_ledger',
    projectedColumns: ['client_id', 'kind', 'detail', 'amount_minor'],
  },
  'db/queries/wallet-reconcile.sql:wallet-reconcile-missing-debits': {
    role: 'wp_scheduler (cron; read-only SECURITY DEFINER owned by wp_admin_app, migration 0053)',
    reason:
      'P18 U8a wallet reconciler check B - cross-tenant scan for settled send_attempts with no matching debit guard in a resolved_at window, executed through wp_wallet_check_missing_debits (migration 0053), same class as wp_reconcile_scan_unresolved',
    projectedColumns: [
      'client_id',
      'send_attempt_id',
      'message_job_id',
      'message_job_created_at',
      'instance_id',
      'job_status',
      'resolved_at',
    ],
  },
  'db/queries/wallet-reconcile.sql:wallet-reconcile-orphan-debits': {
    role: 'wp_scheduler (cron; read-only SECURITY DEFINER owned by wp_admin_app, migration 0053)',
    reason:
      'P18 U8a wallet reconciler check C - cross-tenant scan for debit_send guards with no matching settled attempt in a created_at window, executed through wp_wallet_check_orphan_debits (migration 0053), same class as wp_reconcile_scan_unresolved',
    projectedColumns: ['client_id', 'send_attempt_id', 'ledger_seq', 'attempt_state'],
  },
  'db/queries/wallet-reconcile.sql:wallet-reconcile-rollup-parity': {
    role: 'wp_scheduler (cron; read-only SECURITY DEFINER owned by wp_admin_app, migration 0053)',
    reason:
      'P18 U8a wallet reconciler check D - cross-tenant FULL OUTER JOIN of a fresh one-UTC-day rollup compute against the persisted wallet_daily_summary row, one row per differing field, executed through wp_wallet_check_rollup_parity (migration 0053)',
    projectedColumns: ['client_id', 'instance_id', 'field', 'expected', 'actual'],
  },
  'db/queries/wallet-reconcile.sql:wallet-reconcile-orphan-guards': {
    role: 'wp_scheduler (cron; read-only SECURITY DEFINER owned by wp_admin_app, migration 0053)',
    reason:
      'P18 U8a wallet reconciler check E - cross-tenant scan for wallet_charge_guards rows still unstamped (ledger_seq = 0) more than 10 minutes after the charged job was created - the one-transaction debit canary, executed through wp_wallet_check_orphan_guards (migration 0053)',
    projectedColumns: ['client_id', 'send_attempt_id', 'kind', 'created_at'],
  },
  'db/queries/wallet-reconcile.sql:wallet-rollup-compute': {
    role: 'wp_scheduler (cron; read-only SECURITY DEFINER owned by wp_admin_app, migration 0053)',
    reason:
      'P18 U8a daily rollup job - cross-tenant aggregate of one UTC day of one monthly wallet_ledger partition grouped by (client_id, instance_id), never a full-ledger aggregate, executed through wp_wallet_rollup_compute (migration 0053); the per-tenant upsert of this result (wallet-rollup-upsert, same file) runs separately as wp_app under tenantDb.withTenant',
    projectedColumns: [
      'client_id',
      'instance_id',
      'sent_count',
      'debit_minor',
      'credit_minor',
      'refund_minor',
    ],
  },
  'db/queries/wallet-reconcile.sql:wallet-count-empty-clients': {
    role: 'wp_scheduler (cron; read-only SECURITY DEFINER owned by wp_admin_app, migration 0053)',
    reason:
      'P18 U8a platform gauge - cross-tenant COUNT-only aggregate of wallet_accounts in state = empty, executed through wp_wallet_count_empty_clients (migration 0053); returns a count, never per-row client data',
    projectedColumns: ['clients_empty'],
  },
  'db/queries/contact-imports-pending-clients.sql:contact-imports-pending-clients': {
    role: 'cron (pool user, same as wallet-rollup-compute)',
    reason:
      'P20 Unit U5 (step 6) - the resumable CSV import sweep\'s cross-tenant discovery scan: which clients currently have an uploaded/importing contact_imports row, bounded LIMIT, returning only client_id. Every per-client claim/batch/upsert write is a SEPARATE tenantDb.withTenant transaction, never this function again - same "discover cross-tenant, then re-scope per tenant" idiom as warmup-evaluator.ts#runOnePacingEvaluatorSweep/health-due.sql.',
    projectedColumns: ['client_id'],
  },
  'db/queries/contacts-active-clients.sql:contacts-active-clients': {
    role: 'cron (pool user, same as wallet-rollup-compute)',
    reason:
      'P20 Unit U8 (step 8) - the bounded, cursor-paginated cross-tenant client walk shared by the opt-out mirror reconciler and the import-error/object retention purge sweeps (engine/cron/cron-wiring-contacts-maintenance.ts#listActiveClientIds), returning only client_id, LIMIT-capped and keyed by id > $after_id. Unlike contact-imports-pending-clients.sql this scans EVERY live client, not only those with an in-flight import - both sweeps must eventually reach every tenant, not just the ones currently importing. Every per-client repair/delete write is a SEPARATE tenantDb.withTenant transaction, never this function again.',
    projectedColumns: ['client_id'],
  },
  'db/queries/health-due.sql:health-due': {
    role: 'wp_scheduler',
    reason:
      'P16 Unit E (dirty-set/evaluator-loop, step 9); WARNING 3 fix (P16 fix round) - bounded (LIMIT 200, oldest-due-first) per-tick cross-tenant CLAIM of instance_pacing_state rows whose eval_due_at has passed, same class as discover-instances.sql/lease-scan-unowned.sql/reap-expired-leases.sql (ADR 0018 §4 / scope-delta row 4-5: no singleton loop may be O(active instances)). Now an UPDATE ... WHERE instance_id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING statement (claim-by-conditional-update idiom), not a bare SELECT: it pushes eval_due_at 60s into the future for exactly the rows it returns, so N session-worker replicas running this same timer each claim a disjoint subset - never the same instance_id twice on one tick (previously a bare SELECT let every replica double-evaluate the same due rows). Every downstream per-instance HealthEvaluator.evaluate() call is re-scoped via tenantDb.withTenant(clientId, ...), never this scan again - same idiom as warmup-evaluator.ts#runOnePacingEvaluatorSweep.',
    projectedColumns: ['instance_id', 'client_id'],
  },
  'db/queries/broadcast-campaigns-pending.sql:broadcast-campaigns-pending': {
    role: 'cron (pool user, same as wallet-rollup-compute / contact-imports-pending-clients)',
    reason:
      "P23 Unit U4 (steps 4/5) - the snapshot/expansion cron sweeps' cross-tenant discovery scan: which campaigns currently sit in a given status ('snapshotting' or 'expanding'), oldest updated_at first, bounded LIMIT, answered by campaigns_worker_discovery_idx (migration 0064). Every per-campaign batch write is a SEPARATE tenantDb.withTenant transaction, never this function again - same discover-cross-tenant-then-re-scope idiom as contact-imports-pending-clients.sql.",
    projectedColumns: ['id', 'client_id'],
  },
  ...CROSS_TENANT_QUERIES_P23,
  ...CROSS_TENANT_QUERIES_P25,
  ...CROSS_TENANT_QUERIES_P26,
  ...CROSS_TENANT_QUERIES_P28,
  ...CROSS_TENANT_QUERIES_P28_ADMIN,
  ...CROSS_TENANT_QUERIES_P28_U3C,
});
