import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';

/**
 * platform/metrics/rollup-metrics.ts (P25 observability-and-runbook, Unit U3)
 * - registers the five fleet-wide Postgres-rollup gauges `db-collector.ts`
 * computes once per tick (ADR 0018 S4 - no singleton loop faster than 5
 * minutes; ADR 0006 - durable-first as a monitored fact):
 *
 *   - `wp_messages_out_without_job` - invariant-1 canary: an outbound
 *     provider message id with neither a `message_jobs` row nor echo
 *     evidence. Must be 0 in a healthy fleet.
 *   - `wp_jobs_blocked_needs_review` / `wp_jobs_needs_reconcile` - fleet-wide
 *     counts of `message_jobs` sitting in each human-review status.
 *   - `wp_instances_connected` / `wp_instances_desired_online` - the
 *     session-availability SLO numerator/denominator.
 *
 * NONE carries `client_id`/`instance_id` - all five are fleet-wide
 * aggregates (the four-gauge `INSTANCE_LABELLED_GAUGES` allow-list in
 * `@wp/server-kit`'s `metric-policy.ts` covers per-instance detail only;
 * none of these five is on it, and none should ever be added to it).
 * `wp_wallet_clients_empty`/`wp_stranded_epoch_jobs` already have their own
 * writers (wallet reconciler / epoch sweep) - this module never sets them
 * (one writer per gauge).
 *
 * Same idempotent-registration `WeakMap` pattern as every sibling metrics
 * module (`discovery-metrics.ts`, `wallet-metrics.ts`) - a second
 * `bindRollupMetrics` call for the SAME registry is a safe no-op.
 */

export interface RollupMetricsHandles {
  messagesOutWithoutJob: ReturnType<MetricsRegistry['gauge']>;
  jobsBlockedNeedsReview: ReturnType<MetricsRegistry['gauge']>;
  jobsNeedsReconcile: ReturnType<MetricsRegistry['gauge']>;
  instancesConnected: ReturnType<MetricsRegistry['gauge']>;
  instancesDesiredOnline: ReturnType<MetricsRegistry['gauge']>;
  setFleetRollups: (counts: {
    messagesOutWithoutJob: number;
    jobsBlockedNeedsReview: number;
    jobsNeedsReconcile: number;
    instancesConnected: number;
    instancesDesiredOnline: number;
  }) => void;
}

const registeredMetrics = new WeakMap<MetricsRegistry, RollupMetricsHandles>();

export function bindRollupMetrics(
  registry: MetricsRegistry = defaultMetrics,
): RollupMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const messagesOutWithoutJob = registry.gauge(
    'wp_messages_out_without_job',
    'Outbound provider message ids with neither a message_jobs row nor echo evidence - invariant 1 (durable-first) as a monitored fact; must be 0',
  );
  const jobsBlockedNeedsReview = registry.gauge(
    'wp_jobs_blocked_needs_review',
    'Fleet-wide count of message_jobs in blocked_needs_review',
  );
  const jobsNeedsReconcile = registry.gauge(
    'wp_jobs_needs_reconcile',
    'Fleet-wide count of message_jobs in needs_reconcile',
  );
  const instancesConnected = registry.gauge(
    'wp_instances_connected',
    'Desired-online, non-deleted instances whose health_state is connected',
  );
  const instancesDesiredOnline = registry.gauge(
    'wp_instances_desired_online',
    'Desired-online, non-deleted instances (the session-availability SLO denominator)',
  );

  const handles: RollupMetricsHandles = {
    messagesOutWithoutJob,
    jobsBlockedNeedsReview,
    jobsNeedsReconcile,
    instancesConnected,
    instancesDesiredOnline,
    setFleetRollups: (counts) => {
      messagesOutWithoutJob.set(counts.messagesOutWithoutJob);
      jobsBlockedNeedsReview.set(counts.jobsBlockedNeedsReview);
      jobsNeedsReconcile.set(counts.jobsNeedsReconcile);
      instancesConnected.set(counts.instancesConnected);
      instancesDesiredOnline.set(counts.instancesDesiredOnline);
    },
  };

  registeredMetrics.set(registry, handles);
  return handles;
}
