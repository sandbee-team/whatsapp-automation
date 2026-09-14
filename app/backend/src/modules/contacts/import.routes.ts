import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TenantDb, TenantQueryable } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import {
  createContactImportInputSchema,
  contactImportIdParamSchema,
  listContactImportsInputSchema,
} from '@wp/contracts';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import {
  assertTenantKey,
  ForeignObjectKeyError,
  ObjectNotFoundError,
  type ObjectStore,
} from '../../platform/storage/object-store.js';
import { sniffCsvHeader } from './import-upload.js';
import {
  createContactImport,
  getContactImport,
  cancelContactImport,
  lastErrorReason,
  listContactImports,
  type ContactImportRow,
} from './import.repo.js';
import { registerImportUploadRoute } from './import-upload.routes.js';
import { registerImportErrorsCsvRoute } from './import-errors-csv.routes.js';

/**
 * import.routes.ts (P20 Unit U6, step 5) - the CSV import create/poll/list/
 * cancel HTTP surface. RBAC (enforced HERE, same discipline as `routes.ts`):
 * `viewer`/`agent` may GET (poll/list/errors.csv), only `admin`/`owner` may
 * upload/create/cancel an import (`contacts:import` scope). A foreign or
 * missing `:id`/`storageKey` is ALWAYS 404 NOT_FOUND, never 403/leak
 * (`ForeignObjectKeyError`/`ObjectNotFoundError` both map here).
 *
 * The upload route (`POST /v1/contacts/imports/uploads`) and the CSV error-
 * download route (`GET /v1/contacts/imports/:id/errors.csv`) live in their
 * own sibling modules purely for this file's 300-line cap - re-registered
 * from here so callers still have ONE registration entrypoint.
 */

export interface ContactImportRoutesDeps {
  tenantDb: TenantDb;
  keyProvider: KeyProvider;
  objectStore: ObjectStore;
  now?: () => Date;
}

class ImportForbiddenRoleError extends Error {
  readonly code = 'FORBIDDEN';
  constructor() {
    super('This role may not perform this action.');
    this.name = 'ImportForbiddenRoleError';
  }
}

export class ContactImportNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such contact import.');
    this.name = 'ContactImportNotFoundError';
  }
}

class ImportValidationMappedError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ImportValidationMappedError';
  }
}

function requireImportRole(role: string): void {
  if (role !== 'admin' && role !== 'owner') {
    throw new ImportForbiddenRoleError();
  }
}

/** Maps a foreign/missing storage key to the SAME `NOT_FOUND` shape as a foreign/missing import id - "never leak existence". */
function mapStorageKeyError(err: unknown): unknown {
  if (err instanceof ForeignObjectKeyError || err instanceof ObjectNotFoundError) {
    return new ContactImportNotFoundError();
  }
  return err;
}

/** Maps a bare `ZodError` (e.g. a malformed `:id` path param) to the same 400 VALIDATION_ERROR shape every other schema.parse() failure gets - `sendError` has no ZodError case of its own (m1). */
function mapZodError(err: unknown): unknown {
  return err instanceof z.ZodError ? new ImportValidationMappedError('Invalid request.') : err;
}

export function toImportWire(row: ContactImportRow, lastReason: string | undefined | null) {
  return {
    id: row.id,
    filename: row.filename,
    status: row.status,
    defaultCountry: row.defaultCountry,
    mapping: row.mapping,
    applyTagIds: row.applyTagIds,
    attestationText: row.attestationText,
    attestedByUserId: row.attestedByUserId,
    attestedAt: row.attestedAt,
    cursorRow: row.cursorRow,
    totalRows: row.totalRows,
    importedCount: row.importedCount,
    updatedCount: row.updatedCount,
    invalidCount: row.invalidCount,
    duplicateCount: row.duplicateCount,
    optedOutCount: row.optedOutCount,
    lastErrorReason: row.status === 'failed' ? (lastReason ?? null) : null,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

async function loadImportOrThrow(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<ContactImportRow> {
  const row = await getContactImport(tx, clientId, id);
  if (!row) throw new ContactImportNotFoundError();
  return row;
}

export function registerContactImportRoutes(
  app: FastifyInstance,
  deps: ContactImportRoutesDeps,
  authDeps: AuthDeps,
): void {
  const now = deps.now ?? (() => new Date());

  registerImportUploadRoute(app, deps, authDeps, { requireImportRole });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/contacts/imports',
    policy: 'session',
    scope: 'contacts:import',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        requireImportRole(auth.role);
        const input = createContactImportInputSchema.parse(req.body);

        const row = await deps.tenantDb.withTenant(auth.clientId, async (tx) => {
          assertTenantKey(input.storageKey, auth.clientId);
          const head = await deps.objectStore.head(input.storageKey);
          if (!head) throw new ContactImportNotFoundError();

          const sniff = await sniffCsvHeader(await deps.objectStore.getStream(input.storageKey));
          const clientRow = await tx.query<{ country_code: string }>(
            `SELECT country_code FROM clients WHERE id = $1 -- client_id = id = $1`,
            [auth.clientId],
          );
          const defaultCountry = input.defaultCountry ?? clientRow.rows[0]?.country_code ?? 'IN';

          return createContactImport(tx, {
            clientId: auth.clientId,
            filename: input.filename ?? null,
            storageKey: input.storageKey,
            mapping: input.mapping,
            mappingColumns: sniff.columns,
            defaultCountry,
            applyTagIds: input.applyTagIds ?? [],
            attestationText: input.attestationText,
            attestedByUserId: auth.userId,
            now: now(),
          });
        });

        sendSuccess(reply, requestId, toImportWire(row, undefined), 201);
      } catch (err) {
        const mapped =
          err instanceof z.ZodError
            ? new ImportValidationMappedError('Invalid request body.')
            : mapStorageKeyError(err);
        sendError(reply, requestId, mapped);
      }
    },
  });

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/contacts/imports',
    policy: 'session',
    scope: 'contacts:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        // P28 U5 (item 4): `listContactImportsInputSchema` (=
        // `paginationInputSchema`, `z.coerce.number()`) parsed straight
        // through - was a hand-cast `Number(rawQuery.limit)` with NO
        // rejection path at all (a non-numeric `limit` silently became
        // `NaN`, never a 400).
        const query = listContactImportsInputSchema.parse(req.query);

        const result = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          listContactImports(tx, {
            clientId: auth.clientId,
            limit: query.limit,
            cursor: query.cursor,
          }),
        );

        reply.code(200).send({
          data: { items: result.items.map((row) => toImportWire(row, undefined)) },
          meta: { requestId, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) },
        });
      } catch (err) {
        sendError(reply, requestId, mapZodError(err));
      }
    },
  });

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/contacts/imports/:id',
    policy: 'session',
    scope: 'contacts:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const id = contactImportIdParamSchema.parse(req.params).id;

        const wire = await deps.tenantDb.withTenant(auth.clientId, async (tx) => {
          const row = await loadImportOrThrow(tx, auth.clientId, id);
          const reason =
            row.status === 'failed' ? await lastErrorReason(tx, auth.clientId, id) : undefined;
          return toImportWire(row, reason);
        });

        sendSuccess(reply, requestId, wire);
      } catch (err) {
        sendError(reply, requestId, mapZodError(err));
      }
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/contacts/imports/:id/cancel',
    policy: 'session',
    scope: 'contacts:import',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        requireImportRole(auth.role);
        const id = contactImportIdParamSchema.parse(req.params).id;

        const row = await deps.tenantDb.withTenant(auth.clientId, async (tx) => {
          await loadImportOrThrow(tx, auth.clientId, id);
          return cancelContactImport(tx, auth.clientId, id);
        });

        sendSuccess(reply, requestId, toImportWire(row, undefined));
      } catch (err) {
        sendError(reply, requestId, mapZodError(err));
      }
    },
  });

  registerImportErrorsCsvRoute(app, deps, authDeps, { loadImportOrThrow });
}
