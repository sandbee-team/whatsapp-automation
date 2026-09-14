import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerAdminRoute } from '../../platform/http/route-policy.js';
import { requestIdFor, sendSuccess } from '../../platform/http/error-mapper.js';
import type { StaffAuthDeps } from '../../platform/http/staff-auth-plugin.js';
import { platformRead, type PlatformReadDeps } from '../../platform/platform-read.js';
import { reasonOf, staffCtxOf } from '../clients/clients.routes.js';
import { listStaffAudit } from './audit.read.js';

/**
 * modules/audit/audit.routes.ts (P28 Unit U4, step 7) -
 * `GET /admin/v1/audit`, the staff audit trail.
 *
 * Note the recursion, which is intentional: reading the audit trail is
 * itself a platform read and therefore writes its own `platform.read` audit
 * row. So "who has been reviewing the audit log" is answerable too - an
 * audit surface that could be browsed invisibly would be the obvious place
 * to start if you wanted to know what had been noticed.
 */

const querySchema = z
  .object({
    clientId: z.uuid().optional(),
    staffId: z.uuid().optional(),
    action: z.string().trim().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export interface AuditRoutesDeps {
  read: PlatformReadDeps;
  auth: StaffAuthDeps;
}

export function registerAuditRoutes(app: FastifyInstance, deps: AuditRoutesDeps): void {
  registerAdminRoute(app, deps.auth, {
    method: 'GET',
    path: '/admin/v1/audit',
    policy: 'staff',
    action: 'audit.read',
    handler: async (req, reply) => {
      const query = querySchema.parse(req.query);
      const page = await platformRead(
        deps.read,
        staffCtxOf(req),
        {
          key: 'admin/backend/src/modules/audit/audit.read.ts:listStaffAudit',
          reason: reasonOf(req),
          clientId: query.clientId ?? null,
        },
        (db) => listStaffAudit(db, query),
      );
      sendSuccess(reply, requestIdFor(req), page);
    },
  });
}
