import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';

/**
 * platform/metrics/staff-metrics.ts (P28 Unit U3a, step 4) - registers
 * `wp_staff_mutations_total{action}` (counter), one increment per staff
 * mutation that actually COMMITTED (never on a replay - a replay changed
 * nothing, so it is not a new mutation event). `action` is one of the fixed
 * `StaffAction` strings (`@wp/domain`'s `STAFF_ACTIONS`), already on
 * `@wp/server-kit`'s `metric-policy.ts` `ALLOWED_LABELS` allow-list. Same
 * idempotent-registration `WeakMap` pattern as `notification-metrics.ts`.
 */

export interface StaffMetricsHandles {
  staffMutationsTotal: ReturnType<MetricsRegistry['counter']>;
  incStaffMutation: (action: string) => void;
}

const registeredMetrics = new WeakMap<MetricsRegistry, StaffMetricsHandles>();

export function bindStaffMetrics(registry: MetricsRegistry = defaultMetrics): StaffMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const staffMutationsTotal = registry.counter(
    'wp_staff_mutations_total',
    'Staff mutations that committed via withStaffMutation, by action',
    ['action'],
  );

  const handles: StaffMetricsHandles = {
    staffMutationsTotal,
    incStaffMutation: (action: string) => {
      staffMutationsTotal.inc({ action });
    },
  };

  registeredMetrics.set(registry, handles);
  return handles;
}
