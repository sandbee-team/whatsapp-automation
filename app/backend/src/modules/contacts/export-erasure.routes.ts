import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TenantDb } from '@wp/db';
import { getContactInputSchema } from '@wp/contracts';
import { requestIdFor, sendError } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { provisioningRepo } from '../tenancy/index.js';
import { streamContactsCsv } from './export.js';
import { eraseContact } from './erasure.js';

class ExportErasureValidationMappedError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ExportErasureValidationMappedError';
  }
}

/** A malformed `:id` path param maps to 400 VALIDATION_ERROR, never reaches `::uuid` as a 500 (m1). */
function mapZodError(err: unknown): unknown {
  return err instanceof z.ZodError
    ? new ExportErasureValidationMappedError('Invalid request.')
    : err;
}

/**
 * export-erasure.routes.ts (P20 Unit U6, step 7) - `GET /v1/contacts/
 * export.csv` (owner/admin only, `session_mfa`) and `DELETE /v1/contacts/
 * :id` (owner/admin only, `session_mfa`) - both money/PII-adjacent tenant
 * actions, same MFA tier `POST /v1/wallet/topup-requests` uses
 * (`topups.routes.ts`'s own doc comment). A foreign or missing `:id` is
 * ALWAYS 404 NOT_FOUND, never 403 (same tenant-isolation discipline as
 * `routes.ts`). The export route writes its `audit_logs` row FIRST, inside
 * its own `withTenant` transaction, BEFORE the response stream starts (an
 * export that later fails mid-stream still leaves an honest audit trail of
 * the attempt) - nothing about the file's CONTENT is ever logged.
 */

export interface ExportErasureRoutesDeps {
  tenantDb: TenantDb;
}

class ExportErasureForbiddenRoleError extends Error {
  readonly code = 'FORBIDDEN';
  constructor() {
    super('This role may not perform this action.');
    this.name = 'ExportErasureForbiddenRoleError';
  }
}

function requireOwnerOrAdmin(role: string): void {
  if (role !== 'admin' && role !== 'owner') {
    throw new ExportErasureForbiddenRoleError();
  }
}

export function registerContactExportErasureRoutes(
  app: FastifyInstance,
  deps: ExportErasureRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/contacts/export.csv',
    policy: 'session_mfa',
    scope: 'contacts:export',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      const auth = req.auth!;
      try {
        requireOwnerOrAdmin(auth.role);

        const exportAuditMetadata = provisioningRepo.filterAuditMetadata({ source: 'panel' });
        await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          tx.query(
            `INSERT INTO audit_logs (client_id, actor_type, actor_user_id, action, target_type, metadata)
             VALUES ($1, 'user', $2, 'contacts.export', 'contacts', $3)
             -- client_id = $1`,
            [
              auth.clientId,
              auth.userId,
              exportAuditMetadata ? JSON.stringify(exportAuditMetadata) : null,
            ],
          ),
        );

        reply
          .type('text/csv; charset=utf-8')
          .header('Content-Disposition', 'attachment; filename="contacts.csv"');
        return reply.send(
          Readable.from(
            streamContactsCsv({ tenantDb: deps.tenantDb }, { clientId: auth.clientId }),
          ),
        );
      } catch (err) {
        sendError(reply, requestId, err);
        return undefined;
      }
    },
  });

  registerRoute(app, authDeps, {
    method: 'DELETE',
    path: '/v1/contacts/:id',
    policy: 'session_mfa',
    scope: 'contacts:erase',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        requireOwnerOrAdmin(auth.role);
        const id = getContactInputSchema.parse(req.params).id;

        const result = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          eraseContact(tx, {
            clientId: auth.clientId,
            contactId: id,
            actor: { userId: auth.userId },
          }),
        );

        reply.code(200).send({ data: result, meta: { requestId } });
      } catch (err) {
        sendError(reply, requestId, mapZodError(err));
      }
    },
  });
}
