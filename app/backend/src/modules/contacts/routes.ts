import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import {
  createContactInputSchema,
  updateContactInputSchema,
  listContactsInputSchema,
  setContactTagsInputSchema,
  getContactInputSchema,
} from '@wp/contracts';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import {
  createContactService,
  updateContactService,
  getContactService,
  listContactsService,
  setContactTagsService,
} from './contacts.service.js';
import { registerContactTagsRoutes } from './tags.routes.js';
import type { ContactRow } from './contacts.repo.js';

/**
 * routes.ts (P20 Unit U4, step 4) - the tenant contacts CRUD + tag-link HTTP
 * surface. RBAC (enforced HERE, `route-policy.ts`'s `scope` is an audit
 * label only, same discipline as `webhooks/routes.ts`): `viewer` -> GET
 * only (403 FORBIDDEN otherwise); `agent`/`admin`/`owner` -> create/update/
 * tag-link. Tag create/patch/delete (`tags.routes.ts`) are `owner`/`admin`
 * only. A foreign or missing `:id` is ALWAYS 404 NOT_FOUND, never 403 - RLS
 * plus an explicit `client_id`-scoped `withTenant` transaction makes the row
 * simply not exist from this caller's viewpoint (tenant isolation, core
 * invariant 4). The literal `/v1/contacts/tags*` routes are registered
 * BEFORE `/v1/contacts/:id` (`tags.routes.ts`) so Fastify never treats
 * `tags` as an id.
 */

export interface ContactsRoutesDeps {
  tenantDb: TenantDb;
  keyProvider: KeyProvider;
}

class ForbiddenRoleError extends Error {
  readonly code = 'FORBIDDEN';
  constructor() {
    super('This role may not perform this action.');
    this.name = 'ForbiddenRoleError';
  }
}

class ContactValidationMappedError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ContactValidationMappedError';
  }
}

export class ContactNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such contact.');
    this.name = 'ContactNotFoundError';
  }
}

function requireWriteRole(role: string): void {
  if (role !== 'agent' && role !== 'admin' && role !== 'owner') {
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
      err instanceof z.ZodError ? new ContactValidationMappedError('Invalid request body.') : err;
    sendError(reply, requestId, mapped);
  }
}

function toWire(row: ContactRow) {
  return {
    id: row.id,
    phoneE164: row.phoneE164,
    waJid: row.waJid,
    addressingMode: row.addressingMode,
    displayName: row.displayName,
    firstName: row.firstName,
    lastName: row.lastName,
    attrs: row.attrs,
    source: row.source,
    consentBasis: row.consentBasis,
    optOutState: row.optOutState,
    optedOutAt: row.optedOutAt,
    lastInboundAt: row.lastInboundAt,
    lastOutboundAt: row.lastOutboundAt,
    tags: row.tags,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function registerContactsRoutes(
  app: FastifyInstance,
  deps: ContactsRoutesDeps,
  authDeps: AuthDeps,
): void {
  // Registered first - see module doc on route-ordering.
  registerContactTagsRoutes(app, deps, authDeps);

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/contacts',
    policy: 'session',
    scope: 'contacts:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        // P28 U5 (item 4): `listContactsInputSchema` (extends
        // `paginationInputSchema`) is already `z.coerce.number()` for
        // `limit` - parse `req.query` straight through it rather than
        // hand-casting `Number(...)` first (redundant with, and less direct
        // than, the schema's own coercion).
        const input = listContactsInputSchema.parse(req.query);
        const result = await listContactsService(deps.tenantDb, {
          clientId: auth.clientId,
          limit: input.limit,
          cursor: input.cursor,
          q: input.q,
          tagId: input.tagId,
          optOutState: input.optOutState,
        });
        // `nextCursor` rides in `meta` (task spec) rather than inside
        // `data` - `sendSuccess` hardcodes `meta: { requestId }`, so this
        // route sends the envelope directly instead of going through it.
        reply.code(200).send({
          data: { items: result.items.map(toWire) },
          meta: {
            requestId,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          },
        });
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/contacts/:id',
    policy: 'session',
    scope: 'contacts:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const id = getContactInputSchema.parse(req.params).id;
        const contact = await getContactService(deps.tenantDb, auth.clientId, id);
        if (!contact) throw new ContactNotFoundError();
        sendSuccess(reply, requestId, toWire(contact));
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/contacts',
    policy: 'session',
    scope: 'contacts:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireWriteRole(auth.role);
        const input = createContactInputSchema.parse(req.body);

        const contact = await createContactService(deps.tenantDb, {
          clientId: auth.clientId,
          createdByUserId: auth.userId,
          phone: input.phone,
          defaultCountry: input.defaultCountry,
          displayName: input.displayName,
          firstName: input.firstName,
          lastName: input.lastName,
          attrs: input.attrs,
          consentBasis: input.consentBasis,
          tagIds: input.tagIds,
          keyProvider: deps.keyProvider,
        });

        sendSuccess(reply, requestId, toWire(contact), 201);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'PATCH',
    path: '/v1/contacts/:id',
    policy: 'session',
    scope: 'contacts:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireWriteRole(auth.role);
        const id = getContactInputSchema.parse(req.params).id;
        const input = updateContactInputSchema.parse(req.body);

        const contact = await updateContactService(deps.tenantDb, {
          clientId: auth.clientId,
          id,
          displayName: input.displayName,
          firstName: input.firstName,
          lastName: input.lastName,
          attrs: input.attrs,
        });
        if (!contact) throw new ContactNotFoundError();

        sendSuccess(reply, requestId, toWire(contact));
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/contacts/:id/tags',
    policy: 'session',
    scope: 'contacts:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        requireWriteRole(auth.role);
        const id = getContactInputSchema.parse(req.params).id;
        const input = setContactTagsInputSchema.parse(req.body);

        const result = await setContactTagsService(deps.tenantDb, {
          clientId: auth.clientId,
          contactId: id,
          add: input.add,
          remove: input.remove,
        });
        if (!result) throw new ContactNotFoundError();

        sendSuccess(reply, requestId, { ...toWire(result.contact), tags: result.tags });
      });
    },
  });
}
