import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  createContactTagInputSchema,
  patchContactTagInputSchema,
  deleteContactTagInputSchema,
} from '@wp/contracts';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import type { ContactsRoutesDeps } from './routes.js';
import {
  listContactTags,
  createContactTag,
  patchContactTag,
  deleteContactTag,
  type ContactTagRow,
} from './tags.repo.js';

/**
 * tags.routes.ts (P20 Unit U4, step 4) - `contact_tags` CRUD HTTP surface,
 * split out of `routes.ts` for the 300-line cap
 * (`session-worker-discovery-wiring.ts`'s own split idiom). Registered
 * BEFORE `/v1/contacts/:id` by `routes.ts` so Fastify never treats the
 * literal path segment `tags` as an `:id`. List is `owner`/`admin`/`agent`
 * readable (`contacts:read` scope, same as the rest of the module); create/
 * patch/delete are `owner`/`admin` only.
 */

class TagsForbiddenRoleError extends Error {
  readonly code = 'FORBIDDEN';
  constructor() {
    super('Only an owner or admin may manage contact tags.');
    this.name = 'TagsForbiddenRoleError';
  }
}

class TagValidationMappedError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'TagValidationMappedError';
  }
}

export class ContactTagNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such contact tag.');
    this.name = 'ContactTagNotFoundError';
  }
}

function requireOwnerOrAdmin(role: string): void {
  if (role !== 'owner' && role !== 'admin') {
    throw new TagsForbiddenRoleError();
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
      err instanceof z.ZodError ? new TagValidationMappedError('Invalid request body.') : err;
    sendError(reply, requestId, mapped);
  }
}

function toWire(row: ContactTagRow) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    contactCount: row.contactCount,
    createdAt: row.createdAt,
  };
}

export function registerContactTagsRoutes(
  app: FastifyInstance,
  deps: ContactsRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/contacts/tags',
    policy: 'session',
    scope: 'contacts:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const rows = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          listContactTags(tx, auth.clientId),
        );
        sendSuccess(reply, requestId, { items: rows.map(toWire) });
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/contacts/tags',
    policy: 'session',
    scope: 'contacts:tags',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireOwnerOrAdmin(auth.role);
        const input = createContactTagInputSchema.parse(req.body);

        const row = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          createContactTag(tx, {
            clientId: auth.clientId,
            name: input.name,
            color: input.color,
            createdByUserId: auth.userId,
          }),
        );
        sendSuccess(reply, requestId, toWire(row), 201);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'PATCH',
    path: '/v1/contacts/tags/:id',
    policy: 'session',
    scope: 'contacts:tags',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireOwnerOrAdmin(auth.role);
        const id = deleteContactTagInputSchema.parse(req.params).id;
        const input = patchContactTagInputSchema.parse(req.body);

        const row = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          patchContactTag(tx, {
            clientId: auth.clientId,
            id,
            name: input.name,
            color: input.color,
          }),
        );
        if (!row) throw new ContactTagNotFoundError();

        sendSuccess(reply, requestId, toWire(row));
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'DELETE',
    path: '/v1/contacts/tags/:id',
    policy: 'session',
    scope: 'contacts:tags',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireOwnerOrAdmin(auth.role);
        const id = deleteContactTagInputSchema.parse(req.params).id;

        const deleted = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          deleteContactTag(tx, auth.clientId, id),
        );
        if (!deleted) throw new ContactTagNotFoundError();

        sendSuccess(reply, requestId, { id });
      });
    },
  });
}
