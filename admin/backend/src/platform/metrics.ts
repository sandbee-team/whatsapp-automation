import { createMetricsRegistry, type MetricsRegistry } from '@wp/server-kit';

/**
 * platform/metrics.ts (P28 Unit U4, step 6) - admin-backend's OWN metrics
 * registry, deliberately separate from app-backend's: they are different
 * processes with different scrape targets, and mixing admin traffic into the
 * send path's series would make a spike in staff activity look like a spike
 * in customer sending.
 *
 * Two series, both with low, closed-set cardinality:
 *  - `wp_admin_requests_total{route,status}` - `route` is the registered
 *    route TEMPLATE (`/admin/v1/clients/:id`), never the concrete path, so a
 *    client id can never become a label value and blow up cardinality;
 *  - `wp_admin_platform_reads_total{route}` - one increment per
 *    `platformRead()` call, labelled by the registered read KEY. This is the
 *    metric that makes "how much cross-tenant reading is this platform
 *    doing" answerable at a glance; `audit_logs` holds the per-event detail.
 *
 * Both labels are already on `@wp/server-kit`'s `metric-policy.ts`
 * `ALLOWED_LABELS` list, and neither metric carries `client_id`/`instance_id`
 * (only the four per-instance dashboard gauges may - see
 * `INSTANCE_LABELLED_GAUGES`).
 */

export interface AdminMetricsHandles {
  registry: MetricsRegistry;
  incRequest: (route: string, status: number) => void;
  incPlatformRead: (route: string) => void;
}

export function bindAdminMetrics(
  registry: MetricsRegistry = createMetricsRegistry(),
): AdminMetricsHandles {
  const requestsTotal = registry.counter(
    'wp_admin_requests_total',
    'Admin API requests, by route template and HTTP status',
    ['route', 'status'],
  );
  const platformReadsTotal = registry.counter(
    'wp_admin_platform_reads_total',
    'Audited cross-tenant platform reads performed by admin-backend, by registered read key',
    ['route'],
  );

  return {
    registry,
    incRequest: (route, status) => {
      requestsTotal.inc({ route, status: String(status) });
    },
    incPlatformRead: (route) => {
      platformReadsTotal.inc({ route });
    },
  };
}
