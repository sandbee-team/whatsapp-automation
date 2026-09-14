import type { FastifyInstance } from 'fastify';
import { requestIdFor, sendError, sendSuccess } from '../../../platform/http/error-mapper.js';
import { registerRoute } from '../../../platform/http/route-policy.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import { assertInternalAccess, mapInternalError, sendUnauthorized } from '../internal-access.js';
import { withAdminAppRole } from '../staff-audit.js';
import type { InternalRoutesDeps } from '../internal-routes-deps.js';

/**
 * routes/plans.ts (P28 Unit U3a, step 4) - `GET /internal/v1/plans`, a
 * read-only staff listing of the plan catalogue (used to populate the
 * `clients.plan` change mutation's dropdown, U3b's own scope). No mutation,
 * no `reason`, no idempotency headers - `withAdminAppRole` only.
 */

interface PlanRow extends Record<string, unknown> {
  id: string;
  key: string | null;
  name: string;
  is_default: boolean;
  max_connected_instances: number;
  max_registered_instances: number;
  max_broadcast_recipients: number;
  max_contacts: number;
}

export function registerInternalPlansRoutes(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/internal/v1/plans',
    policy: 'public',
    scope: 'internal:plans.read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        assertInternalAccess(req, deps);
      } catch {
        sendUnauthorized(reply, requestId);
        return;
      }
      try {
        const rows = await withAdminAppRole(deps.pool, (db) =>
          db.query<PlanRow>(
            `SELECT p.id, p.key, p.name, p.is_default,
                    l.max_connected_instances, l.max_registered_instances,
                    l.max_broadcast_recipients, l.max_contacts
               FROM plans p
               JOIN plan_limits l ON l.plan_id = p.id
              ORDER BY p.name ASC`,
          ),
        );

        sendSuccess(reply, requestId, {
          items: rows.rows.map((row) => ({
            id: row.id,
            key: row.key ?? '',
            name: row.name,
            isDefault: row.is_default,
            limits: {
              maxConnectedInstances: row.max_connected_instances,
              maxRegisteredInstances: row.max_registered_instances,
              maxBroadcastRecipients: row.max_broadcast_recipients,
              maxContacts: row.max_contacts,
            },
          })),
        });
      } catch (err) {
        sendError(reply, requestId, mapInternalError(err));
      }
    },
  });
}
