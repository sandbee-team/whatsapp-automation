/**
 * Metric registration policy - CI-guarded, enforced at boot (registration
 * time), never advice.
 *
 * Rationale: above ~2,000 WhatsApp instances, a label whose cardinality
 * scales with instance count (or client count) multiplies every series by
 * that many instances - a few dozen otherwise-modest metrics turn into
 * 150k+ Prometheus series, which is enough to degrade or kill the scrape
 * target (ADR 0018 structural target: 10k logical sessions / ~2,000
 * physical). So `instance_id` and `client_id` are allowed on AT MOST the
 * four named gauges below, which exist specifically to carry per-instance
 * dashboard state; every other metric aggregates by worker/error
 * class/band/plan instead, and per-instance detail is served from
 * PostgreSQL rollups, not Prometheus label cardinality.
 *
 * `metrics.ts` calls the pure functions here during factory registration
 * and throws when a check fails; they are exported standalone so the
 * policy is unit-testable without a `prom-client` Registry.
 */

/** Every `wp_`-prefixed metric name must start with this. */
export const METRIC_PREFIX = 'wp_';

/**
 * The full set of label names any metric may use. Additions require a
 * plan-phase or ADR reference - this is not a place to casually add a new
 * label because one call site wants it.
 */
export const ALLOWED_LABELS: ReadonlySet<string> = new Set([
  'worker_id',
  'error_class',
  'band',
  'plan',
  'priority',
  'status',
  'result',
  'reason',
  'price_key',
  'msg_type',
  'cause',
  'purpose',
  'kek_id',
  'route',
  'event_type',
  'instance_id',
  'client_id',
  // P15 Unit U4 (step 5, outbox relay): `wp_outbox_events_published_total{fanout}`
  // and `wp_outbox_dropped_total{topic_class}` (plan/v1/P15-outbox-relay-and-webhooks.md
  // step 5's own metric list, scope-delta row 7's "every metric here is
  // labelled by fanout, topic_class, error_class or nothing"). Neither
  // carries tenant-scoped cardinality (fanout is {sse,webhook}; topic_class
  // is a small fixed set of event-type strings).
  'fanout',
  'topic_class',
  // P16 step 10 (health-signals-and-pause, plan/v1/P16-health-signals-and-pause.md):
  // `wp_health_band_changes_total{from,to}` and `wp_hard_signal_pauses_total
  // {signal}` - closed small sets (4 health bands; ~12 hard-signal reason
  // keys), never tenant-scoped cardinality - same precedent as the P15
  // `fanout`/`topic_class` entry above.
  'from',
  'to',
  'signal',
  // P17 step 3 (notifications-and-instance-card, plan/v1/P17-notifications-and-instance-card.md):
  // `wp_notifications_total{kind,channel}`, `wp_notify_deduped_total{kind}`,
  // `wp_notification_emails_suppressed_total{kind}` - `kind` is the closed
  // `NotificationKind` enum (8 values), `channel` is the closed
  // `{sse,email,webhook}` set - neither carries tenant-scoped cardinality,
  // same precedent as the P15/P16 entries above. Never client_id/instance_id
  // on any of the three.
  'kind',
  'channel',
  // P28 (admin-internal-api-and-panel): `wp_staff_mutations_total{action}` -
  // `action` is the closed `StaffAction` set (~24 staff action names, see
  // `@wp/domain`'s `STAFF_ACTIONS`), never tenant-scoped cardinality.
  'action',
]);

/** The subset of `ALLOWED_LABELS` that carries per-instance/tenant cardinality. */
export const TENANT_SCOPED_LABELS: readonly string[] = ['instance_id', 'client_id'];

/**
 * The only metrics allowed to carry `instance_id` or `client_id` - exactly
 * these four per-instance dashboard gauges (health, link, queue depth,
 * queue lag). No other metric name may join this list without an ADR.
 */
export const INSTANCE_LABELLED_GAUGES: readonly string[] = [
  'wp_instance_health_state',
  'wp_instance_link_state',
  'wp_instance_queue_depth',
  'wp_instance_oldest_queued_seconds',
];

export type MetricKind = 'counter' | 'gauge' | 'histogram';

/**
 * Validates a metric name + label set against the policy above. Returns
 * nothing on success; throws a plain `Error` naming the metric and the
 * violated rule on failure. Metric names and label names are not secrets,
 * so the error message may include them freely.
 */
export function assertMetricRegistrationAllowed(
  kind: MetricKind,
  name: string,
  labelNames: readonly string[],
): void {
  if (!name.startsWith(METRIC_PREFIX)) {
    throw new Error(`metric "${name}" must start with "${METRIC_PREFIX}" (got: no wp_ prefix)`);
  }

  for (const label of labelNames) {
    if (!ALLOWED_LABELS.has(label)) {
      throw new Error(
        `metric "${name}" uses label "${label}" which is not in ALLOWED_LABELS - ` +
          `adding a new label requires a plan-phase or ADR reference`,
      );
    }
  }

  const usesTenantScopedLabel = labelNames.some((label) => TENANT_SCOPED_LABELS.includes(label));
  if (!usesTenantScopedLabel) {
    return;
  }

  if (!INSTANCE_LABELLED_GAUGES.includes(name)) {
    throw new Error(
      `metric "${name}" uses a tenant-scoped label (instance_id/client_id) but is not one ` +
        `of the four INSTANCE_LABELLED_GAUGES allowed to carry per-instance cardinality - ` +
        `aggregate by worker/error class/band/plan instead, and use PostgreSQL rollups for ` +
        `per-instance detail`,
    );
  }

  if (kind !== 'gauge') {
    throw new Error(
      `metric "${name}" uses a tenant-scoped label (instance_id/client_id) but is a ` +
        `"${kind}", not a "gauge" - only the four INSTANCE_LABELLED_GAUGES (which are all ` +
        `gauges) may carry per-instance cardinality`,
    );
  }
}
