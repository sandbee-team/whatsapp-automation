import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';
import type { FenceLostCause } from '../../engine/lease/session-owner.port.js';

/**
 * platform/metrics/lease-metrics.ts (P06 Unit U5) - registers exactly the
 * three lease-lifecycle Prometheus metrics this phase needs, none of them
 * carrying `instance_id`/`client_id` (the four-gauge allow-list rule in
 * `@wp/server-kit`'s `metric-policy.ts` - none of these three is one of the
 * four `INSTANCE_LABELLED_GAUGES`, so a tenant-scoped label would throw at
 * registration):
 *
 *   - `wp_lease_takeovers_total` (counter, no label) - incremented by
 *     `LeaseManager.acquire` when a mint replaced a DIFFERENT previous
 *     owner (a real takeover; a first-ever mint of a never-leased instance,
 *     or a worker re-minting its own still-held lease, is not a takeover).
 *   - `wp_lease_lost_total{cause}` (counter) - incremented by
 *     `heartbeat.ts` on every self-fence decision; `cause` is one of the
 *     three `FenceLostCause` values (`redis_renew_lost`, `pg_fence_conflict`,
 *     `watchdog`) - `cause` is already on `ALLOWED_LABELS`.
 *   - `wp_fence_regression_total` (counter, no label) - incremented by
 *     `LeaseManager.acquire` when a minted fence is not strictly greater
 *     than the last fence this PROCESS saw for that instance. Should never
 *     fire in practice (Postgres mints monotonically per instance) - this
 *     is a canary, not a normal-path signal.
 *   - `wp_lease_heartbeat_ticks_skipped_total` (counter, no label) -
 *     incremented by `heartbeat.ts`'s `tick()` re-entrancy guard every time
 *     a tick is invoked while a previous tick is still in flight (a
 *     slow-but-alive PG/Redis leg outliving `heartbeatMs`) - the skip
 *     replaces the retry-storm shape of overlapping renew statements ADR
 *     0018 S4 forbids.
 *
 * Same idempotent-registration pattern as `modules/realtime/metrics.ts`: a
 * `WeakMap` keyed by the registry makes a second `bindLeaseMetrics` call for
 * the SAME registry a safe no-op (production calls this once per process;
 * tests re-import across files sharing the default registry).
 */

/**
 * Structurally satisfies BOTH `LeaseManager`'s `LeaseManagerMetricsPort`
 * (`incrementTakeovers`/`incrementFenceRegression`) and `heartbeat.ts`'s
 * `HeartbeatMetricsPort` (`incrementLeaseLost`) - a single handles object
 * can be passed to both constructors without an adapter.
 */
export interface LeaseMetricsHandles {
  takeoversTotal: ReturnType<MetricsRegistry['counter']>;
  lostTotal: ReturnType<MetricsRegistry['counter']>;
  fenceRegressionTotal: ReturnType<MetricsRegistry['counter']>;
  heartbeatTicksSkippedTotal: ReturnType<MetricsRegistry['counter']>;
  incrementTakeovers: () => void;
  incrementLeaseLost: (cause: FenceLostCause) => void;
  incrementFenceRegression: () => void;
  incrementTicksSkipped: () => void;
}

const registeredMetrics = new WeakMap<MetricsRegistry, LeaseMetricsHandles>();

export function bindLeaseMetrics(registry: MetricsRegistry = defaultMetrics): LeaseMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const takeoversTotal = registry.counter(
    'wp_lease_takeovers_total',
    'Session lease takeovers - a mint replaced a different previous owner',
  );
  const lostTotal = registry.counter(
    'wp_lease_lost_total',
    'Session leases self-fenced (lost), by cause',
    ['cause'],
  );
  const fenceRegressionTotal = registry.counter(
    'wp_fence_regression_total',
    'Minted fences that were not strictly greater than the last fence this process saw for the instance (should never fire)',
  );
  const heartbeatTicksSkippedTotal = registry.counter(
    'wp_lease_heartbeat_ticks_skipped_total',
    'Heartbeat ticks skipped because a previous tick was still in flight (re-entrancy guard)',
  );

  const handles: LeaseMetricsHandles = {
    takeoversTotal,
    lostTotal,
    fenceRegressionTotal,
    heartbeatTicksSkippedTotal,
    incrementTakeovers: () => {
      takeoversTotal.inc();
    },
    incrementLeaseLost: (cause: FenceLostCause) => {
      lostTotal.inc({ cause });
    },
    incrementFenceRegression: () => {
      fenceRegressionTotal.inc();
    },
    incrementTicksSkipped: () => {
      heartbeatTicksSkippedTotal.inc();
    },
  };

  registeredMetrics.set(registry, handles);
  return handles;
}
