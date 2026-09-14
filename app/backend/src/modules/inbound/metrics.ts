import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';

/**
 * modules/inbound/metrics.ts - every counter the headless inbound listener
 * emits (P14 U3 + P21). NONE carries `client_id`/`instance_id` (the four-gauge
 * `INSTANCE_LABELLED_GAUGES` allow-list is spent - ADR 0018; enforced at
 * registration by `packages/server-kit/src/obs/metric-policy.ts` and by
 * `metrics.test.ts#no_inbound_metric_carries_a_client_or_instance_label`).
 * Aggregate only, same discipline as `engine/queue/metrics.ts`.
 *
 * - `wp_optout_unattributable_total` (P14): an opt-out keyword match from a
 *   `@lid`-only sender with no resolvable E.164 - counted, never mis-attributed.
 * - `wp_inbound_shed_total`: a message event dropped above the per-instance
 *   admission ceiling, before any processing (unlabelled, like
 *   `wp_worker_sheds_total`).
 * - `wp_inbound_admission_fail_open_total`: an admission check that degraded
 *   to "process it" because Redis was unavailable/timed out - shedding is a
 *   fairness control, never a safety control (core invariant 2).
 * - `wp_inbound_events_total{kind}`: kind = echo | message | receipt | ignored.
 * - `wp_inbound_dead_letters_total{error_class}`: one per `inbound_dead_letters`
 *   row (or `persist_failed` when the row itself could not be written).
 * - `wp_receipts_total{event_type}`: delivered | read | failed rows written to
 *   `delivery_events` through `delivery_event_ids`.
 * - `wp_receipt_unmatched_total`: a receipt whose `wa_msg_id` has no resolved
 *   `message_wa_ids (direction='out')` row - expected, not a dead letter.
 * - `wp_optout_detected_total`: an attributed inbound STOP that wrote an
 *   `opt_outs` row.
 * - `wp_inbound_limit_fallback_total`: a resolved `readLimit` value that was
 *   not a positive integer (0, negative, non-integer) and was replaced by
 *   `defaults.maxPerMinute` instead of being used as a real capacity.
 * - `wp_inbound_overflow_total{kind}`: a socket event dropped by the
 *   per-worker in-flight limiter (`inflight-limiter.ts`) because both its
 *   slot and pending-queue ceilings were full - never queued in memory, the
 *   exact OOM shape ADR 0018 budgets against (C1 fix round, reviewer MAJOR).
 * - `wp_inbound_id_collision_total` (P25 U1b gap-fill): an inbound provider
 *   event id that collided with an already-recorded id - `receipts.ts#
 *   recordInboundReceipt`'s own `writeDeliveryEvent` call resolving
 *   `{inserted: false}` (a duplicate receipt delivered twice).
 *
 * Same idempotent-registration `WeakMap` pattern as `engine/queue/metrics.ts`.
 */
export interface InboundMetricsHandles {
  optOutUnattributableTotal: ReturnType<MetricsRegistry['counter']>;
  inboundShedTotal: ReturnType<MetricsRegistry['counter']>;
  inboundAdmissionFailOpenTotal: ReturnType<MetricsRegistry['counter']>;
  inboundEventsTotal: ReturnType<MetricsRegistry['counter']>;
  inboundDeadLettersTotal: ReturnType<MetricsRegistry['counter']>;
  receiptsTotal: ReturnType<MetricsRegistry['counter']>;
  receiptUnmatchedTotal: ReturnType<MetricsRegistry['counter']>;
  optOutDetectedTotal: ReturnType<MetricsRegistry['counter']>;
  inboundLimitFallbackTotal: ReturnType<MetricsRegistry['counter']>;
  inboundOverflowTotal: ReturnType<MetricsRegistry['counter']>;
  inboundIdCollisionTotal: ReturnType<MetricsRegistry['counter']>;
}

const registeredMetrics = new WeakMap<MetricsRegistry, InboundMetricsHandles>();

export function bindInboundMetrics(
  registry: MetricsRegistry = defaultMetrics,
): InboundMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const handles: InboundMetricsHandles = {
    optOutUnattributableTotal: registry.counter(
      'wp_optout_unattributable_total',
      'Inbound opt-out keyword matches from a sender with no resolvable E.164 (never mis-attributed to a guessed contact)',
    ),
    inboundShedTotal: registry.counter(
      'wp_inbound_shed_total',
      'Inbound message events dropped above the per-instance admission ceiling, before any processing',
    ),
    inboundAdmissionFailOpenTotal: registry.counter(
      'wp_inbound_admission_fail_open_total',
      'Inbound admission checks that failed open (processed anyway) because the Redis bucket was unavailable or timed out',
    ),
    inboundEventsTotal: registry.counter(
      'wp_inbound_events_total',
      'Inbound socket events seen by the dispatcher, by kind (echo, message, receipt, ignored)',
      ['kind'],
    ),
    inboundDeadLettersTotal: registry.counter(
      'wp_inbound_dead_letters_total',
      'Inbound events whose handler threw and were recorded as dead letters, by bounded error class',
      ['error_class'],
    ),
    receiptsTotal: registry.counter(
      'wp_receipts_total',
      'Delivery receipts written to delivery_events, by event type (delivered, read, failed)',
      ['event_type'],
    ),
    receiptUnmatchedTotal: registry.counter(
      'wp_receipt_unmatched_total',
      'Delivery receipts whose wa_msg_id matched no resolved outbound message_wa_ids row (expected for not-yet-acked sends; dropped, not dead-lettered)',
    ),
    optOutDetectedTotal: registry.counter(
      'wp_optout_detected_total',
      'Attributed inbound STOP keyword matches that wrote an opt_outs row',
    ),
    inboundLimitFallbackTotal: registry.counter(
      'wp_inbound_limit_fallback_total',
      'A resolved per-instance inbound limit that was not a positive integer and was replaced by the platform default',
    ),
    inboundOverflowTotal: registry.counter(
      'wp_inbound_overflow_total',
      'Inbound socket events dropped by the per-worker in-flight limiter (slots and pending queue both full), by kind',
      ['kind'],
    ),
    inboundIdCollisionTotal: registry.counter(
      'wp_inbound_id_collision_total',
      'Inbound provider event ids that collided with an already-recorded id (duplicate receipt delivered twice)',
    ),
  };

  registeredMetrics.set(registry, handles);
  return handles;
}
