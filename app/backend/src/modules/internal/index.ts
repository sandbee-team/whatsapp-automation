/**
 * modules/internal - the ONLY public surface of this module (layering rule
 * S3.2: another module imports only this file, never a sibling directly).
 * P19 Unit U5, step 8 shipped the minimal stopgap; P28 Unit U3a, step 4
 * replaces it with the real `/internal/v1` core: `withStaffMutation` (the
 * ONLY entry point for a staff write), `resolveStaffActor`,
 * `computeRequestHash`, and `registerInternalRoutes`, which wires the
 * wallet/topups/plans route groups - and is the ONE place U3b (clients/
 * instances/campaigns) and U3c (impersonation) add their own
 * `registerInternal<Area>Routes` calls (extension point marked below).
 */
import type { FastifyInstance } from 'fastify';
import { config } from '@wp/server-kit';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { registerInternalWalletMutationRoutes } from './routes/wallet.js';
import { registerInternalTopupsRoutes } from './routes/topups.js';
import { registerInternalPlansRoutes } from './routes/plans.js';
import { registerInternalClientRoutes } from './routes/clients.js';
import { registerInternalInstanceRoutes } from './routes/instances.js';
import { registerInternalCampaignRoutes } from './routes/campaigns.js';
import { registerInternalImpersonationRoutes } from './routes/impersonation.js';
import type { InternalRoutesDeps } from './internal-routes-deps.js';

export { withAdminAppRole, computeRequestHash, type AdminAppPool } from './staff-audit.js';
export { signServiceToken, buildServiceTokenHeader } from './service-token.js';
export {
  withStaffMutation,
  type StaffMutationTx,
  type AuditWriteOverride,
} from './with-staff-mutation.js';
export { resolveStaffActor, assertStaffCan, type StaffActor } from './actor.js';
export type { InternalRoutesDeps } from './internal-routes-deps.js';

/**
 * Registers every `/internal/v1` route group this unit owns
 * (wallet/topups/plans). U3b/U3c append their own `registerInternal
 * <Area>Routes(app, deps, authDeps)` calls here - EXTENSION POINT, do not
 * duplicate this function's own gate/wiring logic in a sibling caller.
 *
 * `options.env` (C1 review round 2 MINOR fix) is TEST-ONLY - it exists so
 * this guard is unit-testable without mutating `@wp/server-kit`'s frozen
 * `config` singleton; production callers never pass it, so the guard always
 * reads the real `config.WP_ENV`.
 */
export function registerInternalRoutes(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
  options: { env?: string } = {},
): void {
  const env = options.env ?? config.WP_ENV;
  if (deps.auditWrite && env === 'production') {
    // `auditWrite` is a TEST-ONLY seam (see `InternalRoutesDeps`'s own doc
    // comment on the field) that replaces BOTH `staff_audit_log` writes -
    // reachable in production it would let a caller silently bypass the
    // real audit trail for every staff mutation. Fail closed at wiring
    // time, never a per-request check.
    throw new Error(
      'registerInternalRoutes: deps.auditWrite is set in a production runtime - this is a test-only seam and must never be wired outside a test process.',
    );
  }

  registerInternalWalletMutationRoutes(app, deps, authDeps);
  registerInternalTopupsRoutes(app, deps, authDeps);
  registerInternalPlansRoutes(app, deps, authDeps);
  registerInternalClientRoutes(app, deps, authDeps);
  registerInternalInstanceRoutes(app, deps, authDeps);
  registerInternalCampaignRoutes(app, deps, authDeps);
  registerInternalImpersonationRoutes(app, deps, authDeps);
}
