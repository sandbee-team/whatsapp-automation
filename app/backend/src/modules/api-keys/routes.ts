import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TenantDb } from '@wp/db';
import { createApiKeyInputSchema, revokeApiKeyInputSchema } from '@wp/contracts';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import { createApiKey, listApiKeys, revokeApiKey, ApiKeyNotFoundError } from './service.js';
import type { ApiKeyRow } from './repo.js';

/**
 * routes.ts (go-live U4) - `api_keys` CRUD HTTP surface: `POST /v1/api-keys`,
 * `GET /v1/api-keys`, `POST /v1/api-keys/:id/revoke`. All three
 * `policy: 'session_mfa'` (session-only - an api_key principal can never
 * manage api_keys, see `an_api_key_cannot_reach_a_session_only_route`),
 * scope `api-keys:manage`, owner/admin only - the SAME manual RBAC-in-
 * handler shape `modules/webhooks/routes.ts`'s `requireOwnerOrAdmin`
 * establishes (`route-policy.ts`'s `scope` string is an audit label, not an
 * RBAC check).
 */

export interface ApiKeysRoutesDeps {
  tenantDb: TenantDb;
  /** The `api-key-pepper` KEK provider's raw material - threaded straight into `createApiKey`'s own `pepper` dep. */
  pepper: Buffer;
}

class ForbiddenRoleError extends Error {
  readonly code = 'FORBIDDEN';
  constructor() {
    super('Only an owner or admin may manage API keys.');
    this.name = 'ForbiddenRoleError';
  }
}

class ValidationMappedError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationMappedError';
  }
}

function requireOwnerOrAdmin(role: string): void {
  if (role !== 'owner' && role !== 'admin') {
    throw new ForbiddenRoleError();
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
    const mapped =
      err instanceof z.ZodError ? new ValidationMappedError('Invalid request body.') : err;
    sendError(reply, requestId, mapped);
  }
}

function toWire(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    last4: row.last4,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

export function registerApiKeysRoutes(
  app: FastifyInstance,
  deps: ApiKeysRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/api-keys',
    policy: 'session_mfa',
    scope: 'api-keys:manage',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireOwnerOrAdmin(auth.role);
        const input = createApiKeyInputSchema.parse(req.body);

        const result = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          createApiKey(
            tx,
            { clientId: auth.clientId, userId: auth.userId, name: input.name },
            { pepper: deps.pepper },
          ),
        );

        sendSuccess(reply, requestId, { ...toWire(result.row), key: result.key }, 201);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/api-keys',
    policy: 'session_mfa',
    scope: 'api-keys:manage',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireOwnerOrAdmin(auth.role);
        const rows = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          listApiKeys(tx, auth.clientId),
        );
        sendSuccess(reply, requestId, { items: rows.map(toWire) });
      });
    },
  });

  // `DELETE /v1/api-keys/:id` is the shape `revokeApiKeyContract` declares and
  // the shape the panel calls; an earlier draft served `POST .../:id/revoke`
  // and the panel's revoke button would have 404'd against it. The contract is
  // the single source of truth for the wire shape.
  registerRoute(app, authDeps, {
    method: 'DELETE',
    path: '/v1/api-keys/:id',
    policy: 'session_mfa',
    scope: 'api-keys:manage',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireOwnerOrAdmin(auth.role);
        const id = revokeApiKeyInputSchema.parse({ id: (req.params as { id: string }).id }).id;

        const result = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          revokeApiKey(tx, { clientId: auth.clientId, id }),
        );
        sendSuccess(reply, requestId, result);
      });
    },
  });
}

export { ApiKeyNotFoundError };
