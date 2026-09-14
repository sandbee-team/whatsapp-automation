import type { MetricInventoryEntry } from './metric-inventory.js';

/**
 * metric-inventory-admin.ts (P28 Unit U4, step 6) - the `wp_admin_*` metric
 * entries, owned by `admin/backend/src/platform/metrics.ts`. Split into its
 * own sibling module because `metric-inventory-core-a-m.ts` sits at 268/300
 * lines and two full entries would breach the `max-lines: 300` cap
 * (core-invariants.md's sanctioned split idiom); it is spread into that
 * file, which keeps `CORE_METRIC_INVENTORY` a single flat array and
 * preserves alphabetical order (`wp_admin_*` precedes `wp_auth_*`).
 *
 * admin-backend deliberately uses its OWN registry rather than app-backend's:
 * they are separate processes with separate scrape targets, so a spike in
 * staff activity must never look like a spike in customer sending.
 *
 * Neither entry carries `client_id`/`instance_id` - only the four
 * per-instance dashboard gauges may (`INSTANCE_LABELLED_GAUGES`), and
 * `route` here is the registered route TEMPLATE or read KEY, never a
 * concrete path, so a client id can never become a label value.
 */
export const ADMIN_METRIC_INVENTORY: readonly MetricInventoryEntry[] = Object.freeze([
  {
    name: 'wp_admin_platform_reads_total',
    type: 'counter',
    labels: ['route'],
    module: 'admin/backend/src/platform/metrics.ts',
    alerts: false,
    help: 'Audited cross-tenant platform reads performed by admin-backend, by registered read key',
  },
  {
    name: 'wp_admin_requests_total',
    type: 'counter',
    labels: ['route', 'status'],
    module: 'admin/backend/src/platform/metrics.ts',
    alerts: false,
    help: 'Admin API requests, by route template and HTTP status',
  },
]);
