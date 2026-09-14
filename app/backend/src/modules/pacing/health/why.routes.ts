import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TenantDb } from '@wp/db';
import { requestIdFor, sendError, sendSuccess } from '../../../platform/http/error-mapper.js';
import { registerRoute } from '../../../platform/http/route-policy.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import { readHealthWhy } from './why.service.js';

/**
 * why.routes.ts (P17 Unit U4, step 8) - `GET /v1/instances/:id/health/why`.
 * `policy: 'session'` (a read - same policy as `card.routes.ts`'s own read
 * route). `:id` is validated as a UUID BEFORE it ever reaches Postgres (the
 * P16 resume-route idiom) - an invalid id maps to a `VALIDATION_ERROR`,
 * never a raw driver 500. Tenant scope comes from `req.auth.clientId` (the
 * session) only - never a header/query param.
 */

export interface WhyRoutesDeps {
  tenantDb: TenantDb;
}

class ValidationMappedError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationMappedError';
  }
}

export function registerWhyRoutes(
  app: FastifyInstance,
  deps: WhyRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/instances/:id/health/why',
    policy: 'session',
    scope: 'instances:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const instanceId = z
          .string()
          .uuid()
          .parse((req.params as { id: string }).id);

        const data = await readHealthWhy(deps.tenantDb, { clientId: auth.clientId, instanceId });

        sendSuccess(reply, requestId, data);
      } catch (err) {
        const mapped =
          err instanceof z.ZodError ? new ValidationMappedError('Invalid instance id.') : err;
        sendError(reply, requestId, mapped);
      }
    },
  });
}
