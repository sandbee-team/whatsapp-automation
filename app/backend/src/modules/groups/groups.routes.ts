import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantDb } from '@wp/db';
import { setGroupSendEnabledInputSchema } from '@wp/contracts';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import { GroupSyncRateLimitedError, IdempotencyKeyRequiredError } from './groups.errors.js';
import {
  listGroupsForInstance,
  requestGroupLeave,
  type GroupsServiceDeps,
} from './groups.service.js';
import { setGroupSendEnabled } from './groups-send-enabled.service.js';
import {
  requestGroupSync,
  type GroupsSyncRequestServiceDeps,
} from './groups-sync-request.service.js';

/**
 * groups.routes.ts (P24 Unit U3/U3c, step 4/5) - the tenant group HTTP
 * surface: exactly four routes (`groupsContract`, `@wp/contracts`).
 * Idempotency-Key is mandatory on every mutation, parsed FIRST - a missing
 * header never reaches the service, never writes a row (same idiom as
 * `broadcasts.routes.ts`). A foreign or missing id is ALWAYS 404
 * (`GroupInstanceNotFoundError`/`GroupNotFoundError`). `POST
 * /v1/instances/:id/groups/sync` only records the REQUEST (migration 0068
 * grants `wp_app` a column-scoped UPDATE on `groups_sync_requested_at`
 * only) - the provider call itself happens later, off the request path, on
 * the worker's own sync timer.
 */

export interface GroupRoutesDeps extends GroupsServiceDeps, GroupsSyncRequestServiceDeps {
  tenantDb: TenantDb;
}

const idParamSchema = z.object({ id: z.string().uuid() });
const listQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

class GroupValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'GroupValidationError';
  }
}

function idFrom(req: FastifyRequest): string {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    throw new GroupValidationError('A valid id path parameter is required.');
  }
  return parsed.data.id;
}

/** Parses the mandatory `Idempotency-Key` header FIRST - missing/blank never reaches the service, never writes a row. */
function requireIdempotencyKey(req: FastifyRequest): void {
  const header = req.headers['idempotency-key'];
  if (typeof header !== 'string' || header.trim().length === 0) {
    throw new IdempotencyKeyRequiredError();
  }
}

async function guarded(
  reply: FastifyReply,
  requestId: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof GroupSyncRateLimitedError) {
      reply.header('Retry-After', String(Math.max(0, Math.ceil(err.retryAfterSeconds))));
    }
    const mapped = err instanceof z.ZodError ? new GroupValidationError('Invalid request.') : err;
    sendError(reply, requestId, mapped);
  }
}

export function registerGroupsRoutes(
  app: FastifyInstance,
  deps: GroupRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/instances/:id/groups',
    policy: 'session',
    scope: 'groups:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const instanceId = idFrom(req);
        const query = listQuerySchema.parse(req.query ?? {});
        const result = await listGroupsForInstance(deps, {
          clientId: auth.clientId,
          instanceId,
          cursor: query.cursor,
          limit: query.limit,
        });
        sendSuccess(reply, requestId, result);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/instances/:id/groups/sync',
    policy: 'session_mfa',
    scope: 'groups:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireIdempotencyKey(req);
        const instanceId = idFrom(req);
        const result = await requestGroupSync(deps, {
          clientId: auth.clientId,
          instanceId,
          userId: auth.userId,
        });
        sendSuccess(reply, requestId, result, 202);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'PATCH',
    path: '/v1/groups/:id/send-enabled',
    policy: 'session_mfa',
    scope: 'groups:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireIdempotencyKey(req);
        const id = idFrom(req);
        const input = setGroupSendEnabledInputSchema.parse(req.body);
        const summary = await setGroupSendEnabled(deps, {
          clientId: auth.clientId,
          id,
          userId: auth.userId,
          enable: input.sendEnabled,
        });
        sendSuccess(reply, requestId, summary);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/groups/:id/leave',
    policy: 'session_mfa',
    scope: 'groups:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireIdempotencyKey(req);
        const id = idFrom(req);
        const result = await requestGroupLeave(deps, {
          clientId: auth.clientId,
          id,
          userId: auth.userId,
        });
        sendSuccess(reply, requestId, result, 202);
      });
    },
  });
}
