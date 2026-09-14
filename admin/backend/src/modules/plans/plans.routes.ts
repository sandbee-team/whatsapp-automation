import type { FastifyInstance } from 'fastify';
import { registerAdminRoute } from '../../platform/http/route-policy.js';
import { requestIdFor, sendSuccess } from '../../platform/http/error-mapper.js';
import type { StaffAuthDeps } from '../../platform/http/staff-auth-plugin.js';
import { platformRead, type PlatformReadDeps } from '../../platform/platform-read.js';
import { reasonOf, staffCtxOf } from '../clients/clients.routes.js';
import { listPlans } from './plans.read.js';

/**
 * modules/plans/plans.routes.ts (P28 Unit U4, step 7) -
 * `GET /admin/v1/plans`, the plan catalogue. Gated on `clients.read` rather
 * than a plans-specific action: the catalogue is what a staff member needs
 * to interpret a client's plan key, so anyone who may read clients may read
 * the plan names those keys refer to. Changing a client's plan is a separate
 * action (`clients.plan`) on a separate, mutating route.
 */

export interface PlansRoutesDeps {
  read: PlatformReadDeps;
  auth: StaffAuthDeps;
}

export function registerPlansRoutes(app: FastifyInstance, deps: PlansRoutesDeps): void {
  registerAdminRoute(app, deps.auth, {
    method: 'GET',
    path: '/admin/v1/plans',
    policy: 'staff',
    action: 'clients.read',
    handler: async (req, reply) => {
      const plans = await platformRead(
        deps.read,
        staffCtxOf(req),
        {
          key: 'admin/backend/src/modules/plans/plans.read.ts:listPlans',
          reason: reasonOf(req),
        },
        (db) => listPlans(db),
      );
      sendSuccess(reply, requestIdFor(req), { items: plans });
    },
  });
}
