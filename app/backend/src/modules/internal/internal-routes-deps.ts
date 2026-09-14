import type { TenantDb } from '@wp/db';
import type { InternalAccessDeps } from './internal-access.js';
import type { AdminAppPool } from './staff-audit.js';
import type { AuditWriteOverride } from './with-staff-mutation.js';
import type { StaffMetricsHandles } from '../../platform/metrics/staff-metrics.js';

/**
 * internal-routes-deps.ts (P28 Unit U3a, step 4) - `InternalRoutesDeps`, the
 * ONE shared deps shape every `/internal/v1` route group (`routes/wallet.ts`,
 * `routes/topups.ts`, `routes/plans.ts`, and U3b/U3c's own additions) takes.
 * Split into its own file (not `index.ts`) so a route module can import the
 * TYPE without importing `index.ts`'s own re-export surface (would be a
 * circular import: `index.ts` imports the route modules, which need this
 * type).
 */
export interface InternalRoutesDeps extends InternalAccessDeps {
  pool: AdminAppPool;
  tenantDb: TenantDb;
  publishWake: (clientId: string, instanceId: string) => Promise<void> | void;
  /** Injectable override of BOTH `staff_audit_log` statements - used ONLY by the `a_failed_audit_write_rolls_back_the_mutation` regression test. */
  auditWrite?: AuditWriteOverride;
  metrics?: StaffMetricsHandles;
}
