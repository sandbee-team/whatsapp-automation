import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantDb } from '@wp/db';
import {
  createBroadcastInputSchema,
  cancelBroadcastInputSchema,
  broadcastMutationHeadersSchema,
  listBroadcastsQuerySchema,
} from '@wp/contracts';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import {
  requestIdFor,
  sendError,
  sendSuccess,
  sendImpersonationSafe,
} from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import { isMetadataOnly, redactMessageBodies } from '../identity/index.js';
import { registerRestampRoutes } from './epoch.public.js';
import { IdempotencyKeyRequiredError } from './broadcasts.errors.js';
import {
  createBroadcast,
  startBroadcast,
  pauseBroadcast,
  resumeBroadcast,
  cancelBroadcast,
  getBroadcast,
  listBroadcasts,
  type LifecycleDeps,
} from './lifecycle.service.js';
import { preflightBroadcast } from './preflight.public.js';

/**
 * broadcasts.routes.ts (P23 Unit U5, step 6) - the tenant broadcast lifecycle
 * HTTP surface: create/start/pause/resume/cancel (mandatory `Idempotency-Key`
 * on every one, parsed FIRST - a missing header never reaches the service,
 * never writes a row) plus the keyset list/get read routes. A foreign or
 * missing `:id` is ALWAYS 404, never 403 (RLS + explicit `client_id`-scoped
 * transaction, same idiom as `contacts/routes.ts`).
 */

export interface BroadcastRoutesDeps extends LifecycleDeps {
  tenantDb: TenantDb;
}

const idParamSchema = z.object({ id: z.string().uuid() });

class BroadcastValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'BroadcastValidationError';
  }
}

function idFrom(req: FastifyRequest): string {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    throw new BroadcastValidationError('A valid broadcast id path parameter is required.');
  }
  return parsed.data.id;
}

/** Parses the mandatory `Idempotency-Key` header FIRST - missing/blank never reaches the service, never writes a row. */
function requireIdempotencyKey(req: FastifyRequest): string {
  const parsed = broadcastMutationHeadersSchema.safeParse(req.headers);
  if (!parsed.success) {
    throw new IdempotencyKeyRequiredError();
  }
  return parsed.data['idempotency-key'];
}

async function guarded(
  reply: FastifyReply,
  requestId: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const mapped =
      err instanceof z.ZodError ? new BroadcastValidationError('Invalid request.') : err;
    sendError(reply, requestId, mapped);
  }
}

export function registerBroadcastRoutes(
  app: FastifyInstance,
  deps: BroadcastRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/broadcasts',
    policy: 'session_mfa',
    scope: 'broadcasts:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const idempotencyKey = requireIdempotencyKey(req);
        const input = createBroadcastInputSchema.parse(req.body);

        const detail = await createBroadcast(deps, {
          clientId: auth.clientId,
          actor: { kind: 'user', userId: auth.userId },
          idempotencyKey,
          name: input.name,
          instanceId: input.instanceId,
          audience: input.audience,
          message: input.message,
          priority: input.priority,
          scheduledAt: input.scheduledAt,
        });

        sendSuccess(reply, requestId, detail, 201);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/broadcasts/:id/start',
    policy: 'session_mfa',
    scope: 'broadcasts:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireIdempotencyKey(req);
        const id = idFrom(req);
        const detail = await startBroadcast(
          deps,
          { kind: 'user', userId: auth.userId },
          { clientId: auth.clientId, id },
        );
        sendSuccess(reply, requestId, detail);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/broadcasts/:id/pause',
    policy: 'session_mfa',
    scope: 'broadcasts:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireIdempotencyKey(req);
        const id = idFrom(req);
        const detail = await pauseBroadcast(
          deps,
          { kind: 'user', userId: auth.userId },
          { clientId: auth.clientId, id },
        );
        sendSuccess(reply, requestId, detail);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/broadcasts/:id/resume',
    policy: 'session_mfa',
    scope: 'broadcasts:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireIdempotencyKey(req);
        const id = idFrom(req);
        const detail = await resumeBroadcast(
          deps,
          { kind: 'user', userId: auth.userId },
          { clientId: auth.clientId, id },
        );
        sendSuccess(reply, requestId, detail);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/broadcasts/:id/cancel',
    policy: 'session_mfa',
    scope: 'broadcasts:cancel',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireIdempotencyKey(req);
        const id = idFrom(req);
        const input = cancelBroadcastInputSchema.parse(req.body ?? {});
        const detail = await cancelBroadcast(
          deps,
          { kind: 'user', userId: auth.userId },
          { clientId: auth.clientId, id, reason: input.reason },
        );
        sendSuccess(reply, requestId, detail);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/broadcasts',
    policy: 'session',
    scope: 'broadcasts:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        // P28 U5 (item 4): `listBroadcastsQuerySchema.limit` is already
        // `z.coerce.number()` - parse `req.query` straight through it
        // (`?limit=abc` -> 400 VALIDATION_ERROR via `guarded`'s own
        // `z.ZodError` mapping) rather than hand-casting `Number(...)` first,
        // which both duplicated the schema's own coercion and let a
        // non-numeric `limit` reach the schema as `NaN` instead of the
        // original string (still rejected, but through a less direct path).
        const input = listBroadcastsQuerySchema.parse(req.query);
        const result = await listBroadcasts(deps, {
          clientId: auth.clientId,
          limit: input.limit,
          cursor: input.cursor,
        });
        // P28 U3c: a `metadata_only` impersonation session never sees a
        // broadcast's `message` (template text/body) - `sendImpersonationSafe`
        // deep-strips it, an ordinary or `with_message_bodies` session is
        // unaffected. `reply.code().send()` is used directly here (not
        // `sendSuccess`) for the `nextCursor` meta field - redact first.
        const itemsSafe = isMetadataOnly(req) ? redactMessageBodies(result.items) : result.items;
        reply.code(200).send({
          data: { items: itemsSafe },
          meta: { requestId, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) },
        });
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/broadcasts/:id',
    policy: 'session',
    scope: 'broadcasts:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const id = idFrom(req);
        const detail = await getBroadcast(deps, auth.clientId, id);
        sendImpersonationSafe(req, reply, requestId, detail);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/broadcasts/:id/preflight',
    policy: 'session_mfa',
    scope: 'broadcasts:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const id = idFrom(req);
        const quote = await preflightBroadcast(
          deps,
          { kind: 'user', userId: auth.userId },
          { clientId: auth.clientId, id },
        );
        sendSuccess(reply, requestId, quote);
      });
    },
  });

  registerRestampRoutes(app, { tenantDb: deps.tenantDb }, authDeps);
}
