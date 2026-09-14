import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';

/**
 * platform/metrics/broadcast-metrics.ts (P23 Unit U6, step 7) - registers
 * the three broadcast Prometheus metrics the phase canon names verbatim:
 *
 *   - `wp_stranded_epoch_jobs` (gauge, no label) - fleet-wide count of
 *     `message_jobs` rows in `blocked_needs_review` with
 *     `unresolved_reason = 'session_epoch_advanced'` right now
 *     (`epoch-sweep.ts#countStrandedEpochJobs`). The alert rule lives in
 *     `infra/observability/prometheus/rules/wp-alerts.rules.yml` (P25 wires
 *     Prometheus itself).
 *   - `wp_broadcast_recipients_total{status}` (counter) - one increment per
 *     `campaign_recipients` row entering a status: `pending`/`skipped` at
 *     snapshot time, `queued`/`failed` at expansion time, `cancelled` at
 *     cancel bookkeeping (U5). `status` is the closed
 *     `BROADCAST_RECIPIENT_STATUSES` enum - already on `ALLOWED_LABELS`
 *     (P17's `kind`/`channel` precedent covers the "closed enum label"
 *     shape; `status` itself was added to `ALLOWED_LABELS` earlier, P14).
 *   - `wp_broadcast_expansion_lag_seconds` (histogram, no label) - observed
 *     once per expansion batch: seconds between the campaign's
 *     `snapshot_done_at` and that batch's own commit time.
 *
 * No `client_id`/`instance_id` label on any of the three (10k-label rule,
 * scope delta "Observability" section) - funnels are served from Postgres
 * rollups, never per-instance Prometheus cardinality. Same idempotent-
 * registration `WeakMap` pattern as every other metrics module in this tree
 * (`relay-metrics.ts`, `contacts.ts`, ...).
 */

export interface BroadcastMetricsHandles {
  strandedEpochJobs: ReturnType<MetricsRegistry['gauge']>;
  recipientsTotal: ReturnType<MetricsRegistry['counter']>;
  expansionLagSeconds: ReturnType<MetricsRegistry['histogram']>;
  /** Sets the gauge to an EXACT recount - never incremented/decremented in place (the sweep always recomputes the true fleet-wide count). */
  setStrandedEpochJobs: (count: number) => void;
  /** One increment per recipient row entering `status` - `count` defaults to 1, batch callers pass the batch's own delta. */
  incrementRecipients: (status: string, count?: number) => void;
  observeExpansionLagSeconds: (seconds: number) => void;
}

const registeredMetrics = new WeakMap<MetricsRegistry, BroadcastMetricsHandles>();

export function bindBroadcastMetrics(
  registry: MetricsRegistry = defaultMetrics,
): BroadcastMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const strandedEpochJobs = registry.gauge(
    'wp_stranded_epoch_jobs',
    'Fleet-wide count of message_jobs rows blocked_needs_review with unresolved_reason session_epoch_advanced',
  );
  const recipientsTotal = registry.counter(
    'wp_broadcast_recipients_total',
    'campaign_recipients rows entering a status, by status',
    ['status'],
  );
  const expansionLagSeconds = registry.histogram(
    'wp_broadcast_expansion_lag_seconds',
    'Seconds between a campaign snapshot_done_at and an expansion batch commit',
  );

  const handles: BroadcastMetricsHandles = {
    strandedEpochJobs,
    recipientsTotal,
    expansionLagSeconds,
    setStrandedEpochJobs: (count) => {
      strandedEpochJobs.set(count);
    },
    incrementRecipients: (status, count = 1) => {
      recipientsTotal.inc({ status }, count);
    },
    observeExpansionLagSeconds: (seconds) => {
      expansionLagSeconds.observe(seconds);
    },
  };

  registeredMetrics.set(registry, handles);
  return handles;
}
