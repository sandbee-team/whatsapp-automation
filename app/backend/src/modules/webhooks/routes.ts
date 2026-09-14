import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import {
  createWebhookEndpointInputSchema,
  patchWebhookEndpointInputSchema,
  deleteWebhookEndpointInputSchema,
  testWebhookEndpointInputSchema,
} from '@wp/contracts';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import { safeFetch, type SafeFetchOptions } from '../../platform/http/safe-fetch.js';
import { hashPayload } from './repo.js';
import {
  createWebhookEndpoint,
  listWebhookEndpoints,
  loadWebhookEndpoint,
  patchWebhookEndpoint,
  deleteWebhookEndpoint,
  EndpointNotFoundError,
  type WebhookEndpointRow,
} from './service.js';

/**
 * routes.ts (P15 U5, step 8) - `webhook_endpoints` CRUD HTTP surface, scope
 * `webhooks:manage`, RBAC owner/admin (enforced HERE - `route-policy.ts`'s
 * `scope` string is an audit label, not an RBAC check; every handler below
 * also checks `req.auth.role` explicitly, same manual-check shape this
 * codebase already uses for MFA-adjacent business rules). A cross-tenant
 * `:id` (foreign or absent) is ALWAYS 404 NOT_FOUND, never 403 - RLS plus an
 * explicit `client_id`-scoped `withTenant` transaction makes the row simply
 * not exist from this caller's viewpoint (tenant isolation, core invariant
 * 4 - "never leak existence").
 */

export interface WebhooksRoutesDeps {
  tenantDb: TenantDb;
  keyProvider: KeyProvider;
  fetchFn: (url: string, options: SafeFetchOptions) => ReturnType<typeof safeFetch>;
}

class ForbiddenRoleError extends Error {
  readonly code = 'FORBIDDEN';
  constructor() {
    super('Only an owner or admin may manage webhook endpoints.');
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

function toWire(row: WebhookEndpointRow) {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    createdAt: row.createdAt,
    lastSuccessAt: row.lastSuccessAt,
    consecutiveFailures: row.consecutiveFailures,
    disabledReason: row.disabledReason,
  };
}

export function registerWebhooksRoutes(
  app: FastifyInstance,
  deps: WebhooksRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/webhooks/endpoints',
    policy: 'session',
    scope: 'webhooks:manage',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireOwnerOrAdmin(auth.role);
        const input = createWebhookEndpointInputSchema.parse(req.body);

        const result = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          createWebhookEndpoint(tx, {
            clientId: auth.clientId,
            url: input.url,
            events: input.events,
            keyProvider: deps.keyProvider,
            fetchFn: deps.fetchFn,
          }),
        );

        sendSuccess(reply, requestId, { ...toWire(result.row), secret: result.secret }, 201);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/webhooks/endpoints',
    policy: 'session',
    scope: 'webhooks:manage',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireOwnerOrAdmin(auth.role);
        const rows = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          listWebhookEndpoints(tx, auth.clientId),
        );
        sendSuccess(reply, requestId, { items: rows.map(toWire) });
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'PATCH',
    path: '/v1/webhooks/endpoints/:id',
    policy: 'session',
    scope: 'webhooks:manage',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireOwnerOrAdmin(auth.role);
        const id = (req.params as { id: string }).id;
        const input = patchWebhookEndpointInputSchema.parse({ ...(req.body as object), id });

        const row = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          patchWebhookEndpoint(tx, {
            clientId: auth.clientId,
            id,
            url: input.url,
            events: input.events,
            enabled: input.enabled,
            fetchFn: deps.fetchFn,
          }),
        );
        if (!row) throw new EndpointNotFoundError();

        sendSuccess(reply, requestId, toWire(row));
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'DELETE',
    path: '/v1/webhooks/endpoints/:id',
    policy: 'session',
    scope: 'webhooks:manage',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireOwnerOrAdmin(auth.role);
        const id = deleteWebhookEndpointInputSchema.parse({
          id: (req.params as { id: string }).id,
        }).id;

        const deleted = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          deleteWebhookEndpoint(tx, auth.clientId, id),
        );
        if (!deleted) throw new EndpointNotFoundError();

        sendSuccess(reply, requestId, { id });
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/webhooks/endpoints/:id/test',
    policy: 'session',
    scope: 'webhooks:manage',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireOwnerOrAdmin(auth.role);
        const id = testWebhookEndpointInputSchema.parse({
          id: (req.params as { id: string }).id,
        }).id;

        const result = await deps.tenantDb.withTenant(auth.clientId, async (tx) => {
          const endpoint = await loadWebhookEndpoint(tx, auth.clientId, id);
          if (!endpoint) throw new EndpointNotFoundError();

          // A synthetic test event - a fresh, never-real outbox_event_id
          // (bigint identity column, so a real INSERT is needed to get one)
          // carrying only ids/enums, same "never a fabricated ok without a
          // real durable row" discipline the dispatcher itself follows.
          const outboxResult = await tx.query<{ id: string }>(
            `INSERT INTO outbox_events (client_id, instance_id, event_type, entity_id, payload, coalesce_key, fanout)
             VALUES ($1, NULL, 'webhook.test', $2, $3, NULL, ARRAY['webhook']::text[])
             -- client_id = $1
             RETURNING id`,
            [auth.clientId, id, JSON.stringify({ endpointId: id })],
          );
          const outboxEventId = outboxResult.rows[0]?.id;
          if (!outboxEventId) throw new Error('webhook test: outbox insert returned no id');

          const payload = { endpointId: id };
          const deliveryResult = await tx.query<{ id: string; status: string }>(
            `INSERT INTO webhook_deliveries
               (client_id, outbox_event_id, endpoint_id, event_type, payload_hash, status, next_attempt_at)
             VALUES ($1, $2, $3, 'webhook.test', $4, 'pending', now())
             -- client_id = $1
             ON CONFLICT (outbox_event_id, endpoint_id) DO NOTHING
             RETURNING id, status`,
            [auth.clientId, outboxEventId, id, hashPayload(payload)],
          );
          const delivery = deliveryResult.rows[0];
          if (!delivery) throw new Error('webhook test: delivery insert returned no row');

          return { deliveryId: delivery.id, status: delivery.status };
        });

        sendSuccess(reply, requestId, result);
      });
    },
  });
}
