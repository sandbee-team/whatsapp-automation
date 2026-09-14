import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';

/**
 * platform/metrics/discovery-metrics.ts (P09 Unit U3 step 5) - registers the
 * two fleet-capacity gauges the discovery loop updates each cycle:
 *
 *   - `wp_instances_unowned` (gauge, no label) - count of `desired_state =
 *     'online'`, non-deleted instances with no live lease (`fleet-
 *     gauges.sql`'s `unowned_count` half).
 *   - `wp_fleet_capacity_headroom` (gauge, no label) - Sigma(published worker
 *     caps, summed from the Redis `sys:fleet:caps` hash via
 *     `readFleetCapacityHeadroom`) minus `desired_online_count` (the other
 *     half of `fleet-gauges.sql`).
 *
 * NEITHER carries `instance_id`/`client_id` - both are fleet-wide aggregates,
 * not per-instance detail, so neither needs (or is allowed) a spot on the
 * four-gauge `INSTANCE_LABELLED_GAUGES` allow-list in
 * `@wp/server-kit`'s `metric-policy.ts`.
 *
 * Same idempotent-registration `WeakMap` pattern as
 * `platform/metrics/lease-metrics.ts`/`engine/fleet/metrics.ts`: a second
 * `bindDiscoveryMetrics` call for the SAME registry is a safe no-op.
 */

export interface DiscoveryMetricsHandles {
  instancesUnowned: ReturnType<MetricsRegistry['gauge']>;
  fleetCapacityHeadroom: ReturnType<MetricsRegistry['gauge']>;
}

const registeredMetrics = new WeakMap<MetricsRegistry, DiscoveryMetricsHandles>();

export function bindDiscoveryMetrics(
  registry: MetricsRegistry = defaultMetrics,
): DiscoveryMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const handles: DiscoveryMetricsHandles = {
    instancesUnowned: registry.gauge(
      'wp_instances_unowned',
      'Count of desired-online, non-deleted instances with no live lease',
    ),
    fleetCapacityHeadroom: registry.gauge(
      'wp_fleet_capacity_headroom',
      'Sum of published worker caps minus the desired-online instance count',
    ),
  };

  registeredMetrics.set(registry, handles);
  return handles;
}
