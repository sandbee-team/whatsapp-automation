import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';
import type { RelayMetricsPort } from '../../modules/events/relay-loop.js';

/**
 * P15 C1 FIX F2 / CRIT-3 - `wp_outbox_poison_total{topic_class}`: one
 * increment per row quarantined as poison (a row that never parses as a
 * valid `RealtimeEvent` after `POISON_ATTEMPT_CEILING` attempts - see
 * `relay-loop-poison.ts`). `topic_class` is the row's own `event_type`,
 * matching `wp_outbox_dropped_total`'s label shape exactly - no new label
 * dimension introduced.
 */

/**
 * platform/metrics/relay-metrics.ts (P15 U4, step 5) - registers the five
 * outbox-relay Prometheus metrics the phase task names verbatim (label
 * allow-list: "every metric here is labelled by fanout, topic_class,
 * error_class or nothing" - scope delta row 7, none carry instance_id/
 * client_id):
 *
 *   - `wp_outbox_depth` (gauge, no label) - unpublished row count, read once
 *     per drain tick (`relay-loop.ts`'s own `SELECT count(*) ... WHERE
 *     published_at IS NULL`).
 *   - `wp_outbox_publish_lag_seconds` (histogram, no label) - age (now minus
 *     `created_at`) of the OLDEST row in a tick's claimed batch, observed
 *     once per non-empty tick.
 *   - `wp_outbox_events_published_total{fanout}` (counter) - one increment
 *     per coalesced batch frame published (sse) or per webhook-fanned row
 *     marked published (webhook) - `fanout` is already on `ALLOWED_LABELS`.
 *   - `wp_sse_coalesced_total` (counter, no label) - one increment PER
 *     suppressed (loser) row folded into a winner this tick.
 *   - `wp_outbox_dropped_total{topic_class}` (counter) - one increment per
 *     row silently dropped under backpressure; `topic_class` is the row's
 *     own `event_type` (an ephemeral topic name, e.g.
 *     `instance.pacing_changed`).
 *
 * Same idempotent-registration `WeakMap` pattern as every other metrics
 * module in this tree (`lease-metrics.ts`, `discovery-metrics.ts`, ...).
 */

export interface RelayMetricsHandles extends RelayMetricsPort {
  outboxDepth: ReturnType<MetricsRegistry['gauge']>;
  publishLagSeconds: ReturnType<MetricsRegistry['histogram']>;
  eventsPublishedTotal: ReturnType<MetricsRegistry['counter']>;
  sseCoalescedTotal: ReturnType<MetricsRegistry['counter']>;
  droppedTotal: ReturnType<MetricsRegistry['counter']>;
  poisonedTotal: ReturnType<MetricsRegistry['counter']>;
  /**
   * P15 C1 FIX (minor, roles/relay.ts:75) - a `redis.publish` rejection on
   * the bridge's outbound leg (connection down) is counted here rather than
   * silently vanishing (`createRedisRealtimePublisherOptions.metrics`'s own
   * contract). Reuses `wp_outbox_dropped_total{topic_class}` (already on the
   * label allow-list) with a fixed `redis_publish_rejected` topic_class,
   * never a new metric name.
   */
  incrementDroppedPublish: () => void;
}

const registeredMetrics = new WeakMap<MetricsRegistry, RelayMetricsHandles>();

export function bindRelayMetrics(registry: MetricsRegistry = defaultMetrics): RelayMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const outboxDepth = registry.gauge('wp_outbox_depth', 'Unpublished outbox_events row count');
  const publishLagSeconds = registry.histogram(
    'wp_outbox_publish_lag_seconds',
    'Age (seconds) of the oldest row in a drain tick claimed batch',
  );
  const eventsPublishedTotal = registry.counter(
    'wp_outbox_events_published_total',
    'Outbox events published, by fanout',
    ['fanout'],
  );
  const sseCoalescedTotal = registry.counter(
    'wp_sse_coalesced_total',
    'Outbox rows suppressed (folded into a newer winner) by the coalescer',
  );
  const droppedTotal = registry.counter(
    'wp_outbox_dropped_total',
    'Outbox rows silently dropped under backpressure, by topic_class',
    ['topic_class'],
  );
  const poisonedTotal = registry.counter(
    'wp_outbox_poison_total',
    'Outbox rows quarantined after repeatedly failing to parse as a valid event, by topic_class',
    ['topic_class'],
  );

  const handles: RelayMetricsHandles = {
    outboxDepth,
    publishLagSeconds,
    eventsPublishedTotal,
    sseCoalescedTotal,
    droppedTotal,
    poisonedTotal,
    setOutboxDepth: (depth) => {
      outboxDepth.set(depth);
    },
    observePublishLagSeconds: (seconds) => {
      publishLagSeconds.observe(seconds);
    },
    incrementEventsPublished: (fanout) => {
      eventsPublishedTotal.inc({ fanout });
    },
    incrementSseCoalesced: (count) => {
      sseCoalescedTotal.inc(count);
    },
    incrementDropped: (topicClass, count) => {
      droppedTotal.inc({ topic_class: topicClass }, count);
    },
    incrementPoisoned: (topicClass, count) => {
      poisonedTotal.inc({ topic_class: topicClass }, count);
    },
    incrementDroppedPublish: () => {
      droppedTotal.inc({ topic_class: 'redis_publish_rejected' }, 1);
    },
  };

  registeredMetrics.set(registry, handles);
  return handles;
}
