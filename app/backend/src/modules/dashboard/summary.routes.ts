import type { FastifyInstance } from 'fastify';
import type { TenantDb } from '@wp/db';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { readDashboardSummary, type DashboardServiceRedis } from './summary.service.js';

/**
 * summary.routes.ts (P17 carried item) - `GET /v1/dashboard/summary`.
 * `policy: 'session'` (a read). Tenant scope comes from `req.auth.clientId`
 * (the session) only - never a header/query param.
 */

export interface DashboardRoutesDeps {
  tenantDb: TenantDb;
  /** Optional 5s-per-client cache - see `summary.service.ts`'s own doc for the "no cache -> always recompute" fallback. */
  redis?: DashboardServiceRedis;
  env?: string;
}

export function registerDashboardRoutes(
  app: FastifyInstance,
  deps: DashboardRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/dashboard/summary',
    policy: 'session',
    scope: 'dashboard:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const cache = deps.redis ? { redis: deps.redis, env: deps.env ?? 'dev' } : undefined;
        const summary = await readDashboardSummary(
          deps.tenantDb,
          { clientId: auth.clientId },
          cache,
        );
        sendSuccess(reply, requestId, summary);
      } catch (err) {
        sendError(reply, requestId, err);
      }
    },
  });
}
