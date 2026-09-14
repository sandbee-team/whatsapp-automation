import type { CrossTenantQueryEntry } from './cross-tenant-queries.js';

/**
 * cross-tenant-queries-p25.ts (P25 observability-and-runbook, Unit U3 - max-
 * lines split sibling of `cross-tenant-queries.ts`, spread into that file's
 * `CROSS_TENANT_QUERIES` export). Holds the P25 fleet-rollup and
 * opt-out-rate-check cross-tenant exemption entries that would have pushed
 * the parent registry over the 300-line cap; same entry shape, same review
 * discipline - this is a line-count split, never a laxer exemption path.
 */
export const CROSS_TENANT_QUERIES_P25: Record<string, CrossTenantQueryEntry> = Object.freeze({
  'db/queries/metric-rollups.sql:metric-rollup-fleet': {
    role: 'cron (pool user, same as wallet-rollup-compute / epoch-sweep-instances-pending)',
    reason:
      'P25 Unit U3 (ADR 0018 S4 / the four-gauge rule) - the 5-minute fleet rollup collector (platform/metrics/db-collector.ts): a COUNT-only aggregate of message_wa_ids/message_jobs/whatsapp_instances, never per-row tenant data, feeding five unlabelled fleet-wide gauges (no client_id/instance_id label anywhere - a labelled series here would violate the four-gauge allow-list in @wp/server-kit metric-policy.ts). Same no-top-level-FROM shape as fleet-gauges.sql.',
    projectedColumns: [
      'messages_out_without_job',
      'jobs_blocked_needs_review',
      'jobs_needs_reconcile',
      'instances_connected',
      'instances_desired_online',
    ],
  },
  'db/queries/metric-rollups.sql:optout-rate-flagged-clients': {
    role: 'cron (pool user, same as wallet-rollup-compute / epoch-sweep-instances-pending)',
    reason:
      "P25 Unit U3 - the hourly per-client opt-out-rate check's cross-tenant discovery scan: driven from the small opt_outs table, EVERY client with an opt-out in the 24h window is evaluated (no LIMIT on discovery), per-client acked-send count is a correlated scalar subquery run once per client with an opt-out in the window, and the LIMIT bounds only the FLAGGED (rate-exceeding) output set, ordered by rate descending. This is the ONE genuinely per-client check the blueprint names, implemented as a Postgres check that notify()s the tenant rather than a Prometheus series (a client_id label is forbidden by the four-gauge rule) - every per-client notify() write is a SEPARATE tenantDb.withTenant transaction, never this scan again.",
    projectedColumns: ['client_id', 'acked_sends', 'optouts'],
  },
  'app/backend/src/modules/inbound/optout-rate-check.ts:runOptoutRateCheck': {
    role: 'cron (pool user, same as wallet-rollup-compute / epoch-sweep-instances-pending)',
    reason:
      'P25 C1 fix round - the opt-out-rate dedupe PRE-FILTER: one batched read of `notifications` (client_id = ANY($1) AND dedupe_key = ANY($2) AND kind = optout_rate_high) over the SAME candidate set the registered optout-rate-flagged-clients scan just produced, so a client already notified today never consumes a maxClientsPerRun slot; the storage-layer unique dedupe key inside notify() stays the sole authority (invariant 3). Projects client_id only; never a payload column.',
    projectedColumns: ['client_id'],
  },
});
