import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TenantQueryable } from '@wp/db';
import { contactImportIdParamSchema } from '@wp/contracts';
import { requestIdFor, sendError } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { escapeCsvCell } from './export.js';
import { listImportErrors, type ContactImportRow } from './import.repo.js';
import type { ContactImportRoutesDeps } from './import.routes.js';

class ImportErrorsCsvValidationMappedError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ImportErrorsCsvValidationMappedError';
  }
}

/** A malformed `:id` path param maps to 400 VALIDATION_ERROR, never reaches `::uuid` as a 500 (m1). */
function mapZodError(err: unknown): unknown {
  return err instanceof z.ZodError
    ? new ImportErrorsCsvValidationMappedError('Invalid request.')
    : err;
}

/**
 * import-errors-csv.routes.ts (P20 Unit U6, step 5) - `GET /v1/contacts/
 * imports/:id/errors.csv`, split out of `import.routes.ts` purely for that
 * file's 300-line cap (same split idiom as `session-worker-discovery-
 * wiring.ts`). Streams `row_no,reason,raw_excerpt` in keyset pages of 1,000
 * (`listImportErrors`'s own keyset, never `OFFSET`), each cell escaped via
 * `escapeCsvCell` - the SAME authorised, tenant-scoped session route IS the
 * "short-lived download" (no object URL is ever exposed to a caller).
 */

const ERRORS_PAGE_SIZE = 1000;
const ERRORS_HEADER = 'row_no,reason,raw_excerpt\n';

async function* streamImportErrorsCsv(
  tx: TenantQueryable,
  input: { clientId: string; importId: string },
): AsyncGenerator<string> {
  yield ERRORS_HEADER;
  let afterRowNo: number | undefined;

  for (;;) {
    const page = await listImportErrors(tx, {
      clientId: input.clientId,
      importId: input.importId,
      afterRowNo,
      limit: ERRORS_PAGE_SIZE,
    });
    if (page.length === 0) return;

    for (const row of page) {
      yield [
        escapeCsvCell(String(row.rowNo)),
        escapeCsvCell(row.reason),
        escapeCsvCell(row.rawExcerpt),
      ].join(',') + '\n';
    }
    afterRowNo = page.at(-1)?.rowNo;
  }
}

export function registerImportErrorsCsvRoute(
  app: FastifyInstance,
  deps: ContactImportRoutesDeps,
  authDeps: AuthDeps,
  gate: {
    loadImportOrThrow: (
      tx: TenantQueryable,
      clientId: string,
      id: string,
    ) => Promise<ContactImportRow>;
  },
): void {
  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/contacts/imports/:id/errors.csv',
    policy: 'session',
    scope: 'contacts:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const id = contactImportIdParamSchema.parse(req.params).id;

        const lines: string[] = await deps.tenantDb.withTenant(auth.clientId, async (tx) => {
          await gate.loadImportOrThrow(tx, auth.clientId, id);
          const collected: string[] = [];
          for await (const line of streamImportErrorsCsv(tx, {
            clientId: auth.clientId,
            importId: id,
          })) {
            collected.push(line);
          }
          return collected;
        });

        reply
          .type('text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="import-${id}-errors.csv"`)
          .code(200)
          .send(lines.join(''));
      } catch (err) {
        sendError(reply, requestId, mapZodError(err));
      }
    },
  });
}
