import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TenantDb } from '@wp/db';
import { listNotificationsInputSchema } from '@wp/contracts';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import {
  listNotificationsForClient,
  markAllNotificationsRead,
  markNotificationRead,
  unreadCountForClient,
} from './notifications.service.js';

/**
 * notifications.routes.ts (P17 U6, step 6) - the in-app notifications API:
 * `GET /v1/notifications` (keyset), `GET /v1/notifications/unread-count`,
 * `POST /v1/notifications/:id/read`, `POST /v1/notifications/read-all`.
 * `policy: 'session'` on every route (a read, or a mutation scoped to the
 * caller's own read state - never a state change to the underlying
 * pause/health/pacing condition itself) - tenant scope comes from
 * `req.auth.clientId` (the session) only, matching `card.routes.ts`'s own
 * idiom. `:id` is UUID-validated BEFORE it ever reaches Postgres (the
 * `card.routes.ts`/resume-route idiom).
 */

export interface NotificationsRoutesDeps {
  tenantDb: TenantDb;
}

class NotificationsValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'NotificationsValidationError';
  }
}

function mapValidation(err: unknown): unknown {
  return err instanceof z.ZodError ? new NotificationsValidationError('Invalid request.') : err;
}

export function registerNotificationsRoutes(
  app: FastifyInstance,
  deps: NotificationsRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/notifications',
    policy: 'session',
    scope: 'notifications:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const input = listNotificationsInputSchema.parse(req.query);

        const result = await listNotificationsForClient(deps.tenantDb, {
          clientId: auth.clientId,
          limit: input.limit,
          cursor: input.cursor,
          unread: input.unread,
        });

        sendSuccess(reply, requestId, result);
      } catch (err) {
        sendError(reply, requestId, mapValidation(err));
      }
    },
  });

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/notifications/unread-count',
    policy: 'session',
    scope: 'notifications:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const count = await unreadCountForClient(deps.tenantDb, auth.clientId);
        sendSuccess(reply, requestId, { count });
      } catch (err) {
        sendError(reply, requestId, err);
      }
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/notifications/:id/read',
    policy: 'session',
    scope: 'notifications:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const id = z
          .string()
          .uuid()
          .parse((req.params as { id: string }).id);

        const result = await markNotificationRead(deps.tenantDb, {
          clientId: auth.clientId,
          id,
          userId: auth.userId,
        });

        sendSuccess(reply, requestId, result);
      } catch (err) {
        sendError(reply, requestId, mapValidation(err));
      }
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/notifications/read-all',
    policy: 'session',
    scope: 'notifications:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const result = await markAllNotificationsRead(deps.tenantDb, {
          clientId: auth.clientId,
          userId: auth.userId,
        });
        sendSuccess(reply, requestId, result);
      } catch (err) {
        sendError(reply, requestId, err);
      }
    },
  });
}
