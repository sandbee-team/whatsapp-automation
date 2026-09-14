import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';

/**
 * platform/metrics/notification-metrics.ts (P17 U3, step 3) - registers the
 * notifications feature's Prometheus counters (label allow-list: `kind`
 * (the closed `NotificationKind` enum) and `channel` (the closed
 * `{sse,email,webhook}` set) - see `@wp/server-kit`'s `metric-policy.ts`,
 * P17 addition citing this phase). NEVER a `client_id`/`instance_id` label
 * on any of these three, matching `relay-metrics.ts`'s own precedent.
 *
 *   - `wp_notifications_total{kind,channel}` (counter) - one increment per
 *     outbox row `notify()`'s own statement actually wrote (one per
 *     channel in the kind's registry `channels` list) - never incremented
 *     on a deduped call (zero outbox rows written, see `notify.ts`).
 *   - `wp_notify_deduped_total{kind}` (counter) - one increment per `notify()`
 *     call whose INSERT hit `ON CONFLICT ... DO NOTHING` (zero rows
 *     returned).
 *   - `wp_notification_emails_suppressed_total{kind}` (counter) - one
 *     increment per notification email the per-client hourly cap
 *     suppressed (step 4, `dispatch/email.ts`) - the cap NEVER applies to
 *     in-app or webhook, so this counter only ever reflects the email leg.
 *   - `wp_notification_email_failures_total{kind}` (counter, P17 fix round
 *     F1) - one increment per email SEND that threw (SMTP error or any
 *     per-row failure) inside `dispatch/email.ts`'s per-row isolation loop -
 *     the failure is swallowed there (never re-thrown into the relay's own
 *     drain tick), this counter plus one redaction-safe log line (no
 *     recipient address) is the sole evidence trail for a lost email.
 *
 * Same idempotent-registration `WeakMap` pattern as every other metrics
 * module in this tree (`relay-metrics.ts`, `lease-metrics.ts`, ...).
 */

export interface NotificationMetricsHandles {
  notificationsTotal: ReturnType<MetricsRegistry['counter']>;
  notifyDedupedTotal: ReturnType<MetricsRegistry['counter']>;
  emailsSuppressedTotal: ReturnType<MetricsRegistry['counter']>;
  emailFailuresTotal: ReturnType<MetricsRegistry['counter']>;
  incrementNotifications: (kind: string, channel: string) => void;
  incrementDeduped: (kind: string) => void;
  incrementEmailsSuppressed: (kind: string) => void;
  incrementEmailFailures: (kind: string) => void;
}

const registeredMetrics = new WeakMap<MetricsRegistry, NotificationMetricsHandles>();

export function bindNotificationMetrics(
  registry: MetricsRegistry = defaultMetrics,
): NotificationMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const notificationsTotal = registry.counter(
    'wp_notifications_total',
    'Notification outbox fan-out rows written, by kind and channel',
    ['kind', 'channel'],
  );
  const notifyDedupedTotal = registry.counter(
    'wp_notify_deduped_total',
    'notify() calls suppressed by the dedupe unique constraint, by kind',
    ['kind'],
  );
  const emailsSuppressedTotal = registry.counter(
    'wp_notification_emails_suppressed_total',
    'Notification emails suppressed by the per-client hourly cap, by kind',
    ['kind'],
  );
  const emailFailuresTotal = registry.counter(
    'wp_notification_email_failures_total',
    'Notification email sends that failed (SMTP or any per-row error), by kind',
    ['kind'],
  );

  const handles: NotificationMetricsHandles = {
    notificationsTotal,
    notifyDedupedTotal,
    emailsSuppressedTotal,
    emailFailuresTotal,
    incrementNotifications: (kind, channel) => {
      notificationsTotal.inc({ kind, channel });
    },
    incrementDeduped: (kind) => {
      notifyDedupedTotal.inc({ kind });
    },
    incrementEmailsSuppressed: (kind) => {
      emailsSuppressedTotal.inc({ kind });
    },
    incrementEmailFailures: (kind) => {
      emailFailuresTotal.inc({ kind });
    },
  };

  registeredMetrics.set(registry, handles);
  return handles;
}
