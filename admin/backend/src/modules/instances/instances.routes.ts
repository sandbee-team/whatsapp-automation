import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerAdminRoute } from '../../platform/http/route-policy.js';
import { requestIdFor, sendSuccess } from '../../platform/http/error-mapper.js';
import type { StaffAuthDeps } from '../../platform/http/staff-auth-plugin.js';
import { platformRead, type PlatformReadDeps } from '../../platform/platform-read.js';
import { reasonOf, staffCtxOf } from '../clients/clients.routes.js';
import { listInstances } from './instances.read.js';

/**
 * modules/instances/instances.routes.ts (P28 Unit U4, step 7) -
 * `GET /admin/v1/instances`. Same fixed pipeline as every other read route:
 * `'staff'` policy (authenticate + `assertStaffCan('instances.read')`) then
 * `platformRead`, which supplies the role and the audit row.
 */

const listQuerySchema = z
  .object({
    healthState: z.string().trim().min(1).max(40).optional(),
    clientId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export interface InstancesRoutesDeps {
  read: PlatformReadDeps;
  auth: StaffAuthDeps;
}

export function registerInstancesRoutes(app: FastifyInstance, deps: InstancesRoutesDeps): void {
  registerAdminRoute(app, deps.auth, {
    method: 'GET',
    path: '/admin/v1/instances',
    policy: 'staff',
    action: 'instances.read',
    handler: async (req, reply) => {
      const query = listQuerySchema.parse(req.query);
      const page = await platformRead(
        deps.read,
        staffCtxOf(req),
        {
          key: 'admin/backend/src/modules/instances/instances.read.ts:listInstances',
          reason: reasonOf(req),
          clientId: query.clientId ?? null,
        },
        (db) => listInstances(db, query),
      );
      sendSuccess(reply, requestIdFor(req), page);
    },
  });
}
