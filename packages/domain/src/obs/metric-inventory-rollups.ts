import type { MetricInventoryEntry } from './metric-inventory.js';

/**
 * metric-inventory-rollups.ts (P25 observability-and-runbook) - the five
 * fleet-wide Postgres-rollup gauges `platform/metrics/db-collector.ts`
 * computes once per 5-minute tick (see that module's own header and
 * `platform/metrics/rollup-metrics.ts`'s registration). All five carry
 * `alerts: true` - every one feeds an alert/recording rule under
 * infra/observability.
 */
const ROLLUP_MODULE = 'app/backend/src/platform/metrics/rollup-metrics.ts';

export const ROLLUP_METRIC_INVENTORY: readonly MetricInventoryEntry[] = Object.freeze([
  {
    name: 'wp_messages_out_without_job',
    type: 'gauge',
    labels: [],
    module: ROLLUP_MODULE,
    alerts: true,
    help: 'Outbound provider message ids with neither a message_jobs row nor echo evidence - invariant 1 (durable-first) as a monitored fact; must be 0',
  },
  {
    name: 'wp_jobs_blocked_needs_review',
    type: 'gauge',
    labels: [],
    module: ROLLUP_MODULE,
    alerts: true,
    help: 'Fleet-wide count of message_jobs in blocked_needs_review',
  },
  {
    name: 'wp_jobs_needs_reconcile',
    type: 'gauge',
    labels: [],
    module: ROLLUP_MODULE,
    alerts: true,
    help: 'Fleet-wide count of message_jobs in needs_reconcile',
  },
  {
    name: 'wp_instances_connected',
    type: 'gauge',
    labels: [],
    module: ROLLUP_MODULE,
    alerts: true,
    help: 'Desired-online, non-deleted instances whose health_state is connected',
  },
  {
    name: 'wp_instances_desired_online',
    type: 'gauge',
    labels: [],
    module: ROLLUP_MODULE,
    alerts: true,
    help: 'Desired-online, non-deleted instances (the session-availability SLO denominator)',
  },
]);
