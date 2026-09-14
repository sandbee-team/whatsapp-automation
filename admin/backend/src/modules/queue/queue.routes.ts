import type { FastifyInstance } from 'fastify';
import { registerAdminRoute } from '../../platform/http/route-policy.js';
import { requestIdFor, sendSuccess } from '../../platform/http/error-mapper.js';
import type { StaffAuthDeps } from '../../platform/http/staff-auth-plugin.js';
import { platformRead, type PlatformReadDeps } from '../../platform/platform-read.js';
import { reasonOf, staffCtxOf } from '../clients/clients.routes.js';
import { readQueueSummary } from './queue.read.js';

/**
 * modules/queue/queue.routes.ts (P28 Unit U4, step 7) -
 * `GET /admin/v1/queue/summary`, the whole-fleet counts view. It takes no
 * query parameters at all: the summary is deliberately not sliceable, so
 * there is no way to turn it into a per-tenant probe. Per-tenant depth is
 * already on the client-detail instance panel, where it is audited against
 * that client_id.
 */

export interface QueueRoutesDeps {
  read: PlatformReadDeps;
  auth: StaffAuthDeps;
}

export function registerQueueRoutes(app: FastifyInstance, deps: QueueRoutesDeps): void {
  registerAdminRoute(app, deps.auth, {
    method: 'GET',
    path: '/admin/v1/queue/summary',
    policy: 'staff',
    action: 'queue.read',
    handler: async (req, reply) => {
      const summary = await platformRead(
        deps.read,
        staffCtxOf(req),
        {
          key: 'admin/backend/src/modules/queue/queue.read.ts:readQueueSummary',
          reason: reasonOf(req),
        },
        (db) => readQueueSummary(db),
      );
      sendSuccess(reply, requestIdFor(req), summary);
    },
  });
}
