import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerAdminRoute } from '../../platform/http/route-policy.js';
import { requestIdFor, sendSuccess } from '../../platform/http/error-mapper.js';
import type { StaffAuthDeps } from '../../platform/http/staff-auth-plugin.js';
import { platformRead, type PlatformReadDeps } from '../../platform/platform-read.js';
import { reasonOf, staffCtxOf } from '../clients/clients.routes.js';
import { listTopups } from './topups.read.js';

/**
 * modules/topups/topups.routes.ts (P28 Unit U4, step 7) -
 * `GET /admin/v1/topups`, the review queue. The DECISION endpoints
 * (approve/reject) are mutation proxies into `/internal/v1` and are not in
 * this module: admin-backend has no UPDATE grant on `topup_requests` at all
 * (migration 0058), so approving is structurally impossible from here -
 * which is exactly the property that keeps `wallet_ledger` single-writer.
 */

const querySchema = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export interface TopupsRoutesDeps {
  read: PlatformReadDeps;
  auth: StaffAuthDeps;
}

export function registerTopupsRoutes(app: FastifyInstance, deps: TopupsRoutesDeps): void {
  registerAdminRoute(app, deps.auth, {
    method: 'GET',
    path: '/admin/v1/topups',
    policy: 'staff',
    action: 'topups.read',
    handler: async (req, reply) => {
      const query = querySchema.parse(req.query);
      const page = await platformRead(
        deps.read,
        staffCtxOf(req),
        {
          key: 'admin/backend/src/modules/topups/topups.read.ts:listTopups',
          reason: reasonOf(req),
        },
        (db) => listTopups(db, query),
      );
      sendSuccess(reply, requestIdFor(req), page);
    },
  });
}
