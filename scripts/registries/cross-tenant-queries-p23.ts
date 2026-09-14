import type { CrossTenantQueryEntry } from './cross-tenant-queries.js';

/**
 * cross-tenant-queries-p23.ts (P23 C1 fix round, unit F1 - max-lines split
 * sibling of `cross-tenant-queries.ts`, spread into that file's
 * `CROSS_TENANT_QUERIES` export). Holds the P23 epoch-sweep and
 * cancel-bookkeeping cross-tenant exemption entries that pushed the parent
 * registry over the 300-line cap; same entry shape, same review discipline
 * - this is a line-count split, never a laxer exemption path.
 */
export const CROSS_TENANT_QUERIES_P23: Record<string, CrossTenantQueryEntry> = Object.freeze({
  'db/queries/broadcast-cancel-bookkeeping-pending.sql:broadcast-cancel-bookkeeping-pending': {
    role: 'cron (pool user, same as broadcast-campaigns-pending)',
    reason:
      "P23 C1 fix-round F1 - the cancel-bookkeeping sweep's OWN cross-tenant discovery scan: cancelled campaigns that still have non-terminal campaign_recipients or still-queued message_jobs, oldest updated_at first, bounded LIMIT. Deliberately separate from broadcast-campaigns-pending.sql (that query has no notion of remaining work and would re-pick the same finished cancelled campaigns forever, starving a later-cancelled campaign whose inline bookkeeping crashed). Every per-campaign batch write is a SEPARATE tenantDb.withTenant transaction, never this function again.",
    projectedColumns: ['id', 'client_id'],
  },
  'db/queries/epoch-sweep-instances-pending.sql:epoch-sweep-instances-pending': {
    role: 'cron (pool user, same as broadcast-campaigns-pending / wallet-rollup-compute)',
    reason:
      'P23 Unit U6 (step 7) - the periodic epoch-stranding reconciliation sweep (belt-and-braces for a hook missed by a crash, engine/cron/cron-wiring-epoch.ts): every LIVE instance, keyset-paginated by id, bounded LIMIT. No join to message_jobs (would require a new SECURITY DEFINER function) - every per-instance write is a SEPARATE tenantDb.withTenant transaction (epoch-sweep.ts#runEpochStrandingSweep); an instance with no stranded rows moves 0 rows on its own call.',
    projectedColumns: ['id', 'client_id', 'session_epoch'],
  },
  'app/backend/src/modules/broadcasts/epoch-sweep.ts:countStrandedEpochJobs': {
    role: 'cron (pool user, same as wallet-count-empty-clients)',
    reason:
      "P23 Unit U6 (step 7) - the wp_stranded_epoch_jobs gauge's fleet-wide recount: a COUNT-only aggregate of message_jobs rows in blocked_needs_review/session_epoch_advanced, never per-row data - same shape as fleet-gauges.sql/wallet-count-empty-clients.",
    projectedColumns: ['count'],
  },
  'db/queries/broadcast-funnel-pending.sql:funnel-active': {
    role: 'cron (pool user, same as broadcast-campaigns-pending)',
    reason:
      "P23a Unit U2 - the progress-funnel active-campaign recompute sweep's cross-tenant discovery scan: campaigns currently doing visible work (snapshotting/expanding/running/paused), oldest updated_at first, bounded LIMIT. Every per-campaign recompute (reconcileCounters + completeIfDrained + emitProgress) is a SEPARATE tenantDb.withTenant transaction, never this scan again - same discover-cross-tenant-then-re-scope idiom as broadcast-campaigns-pending.sql.",
    projectedColumns: ['id', 'client_id'],
  },
  'db/queries/broadcast-funnel-pending.sql:funnel-hourly': {
    role: 'cron (pool user, same as broadcast-campaigns-pending)',
    reason:
      "P23a Unit U2 - the progress-funnel hourly crash-reconciliation sweep's cross-tenant discovery scan: the same active-campaign set UNIONed with terminal campaigns (completed/cancelled/failed) that are either recently updated or whose campaign_counters.recomputed_at was never set (belt-and-braces for a crash before the active loop's first tick), bounded LIMIT. Same per-campaign re-scope discipline as funnel-active above.",
    projectedColumns: ['id', 'client_id'],
  },
});
