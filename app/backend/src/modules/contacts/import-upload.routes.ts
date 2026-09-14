import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { ObjectTooLargeError } from '../../platform/storage/object-store.js';
import { sniffCsvHeader, MAX_UPLOAD_BYTES } from './import-upload.js';
import type { ContactImportRoutesDeps } from './import.routes.js';

/**
 * import-upload.routes.ts (P20 Unit U6, step 5) - `POST /v1/contacts/
 * imports/uploads`, split out of `import.routes.ts` purely for that file's
 * 300-line cap (same split idiom as `session-worker-discovery-wiring.ts`).
 *
 * The request MUST be `Content-Type: text/csv` - anything else is rejected
 * with 415 BEFORE any body is read (`preValidation`, cheaper than a content-
 * type parser round-trip for a wrong-shaped request). The `text/csv` parser
 * itself is a RAW passthrough (registered once, guarded by
 * `hasContentTypeParser` so a second `registerContactImportRoutes` call in
 * the same process - e.g. two test files sharing one Fastify instance-
 * builder - never double-registers it) - the body is STREAMED straight into
 * `objectStore.put`, never buffered whole in this route.
 */

class UnsupportedMediaTypeError extends Error {
  readonly code = 'UNSUPPORTED_MEDIA_TYPE';
  constructor() {
    super('This endpoint only accepts Content-Type: text/csv.');
    this.name = 'UnsupportedMediaTypeError';
  }
}

export function registerImportUploadRoute(
  app: FastifyInstance,
  deps: ContactImportRoutesDeps,
  authDeps: AuthDeps,
  gate: { requireImportRole: (role: string) => void },
): void {
  if (!app.hasContentTypeParser('text/csv')) {
    app.addContentTypeParser(
      'text/csv',
      (_req, payload: Readable, done: (err: Error | null, body?: unknown) => void) => {
        done(null, payload);
      },
    );
  }

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/contacts/imports/uploads',
    policy: 'session',
    scope: 'contacts:import',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        gate.requireImportRole(auth.role);

        const contentType = req.headers['content-type'] ?? '';
        if (!contentType.toLowerCase().startsWith('text/csv')) {
          throw new UnsupportedMediaTypeError();
        }

        const now = deps.now?.() ?? new Date();
        let stored;
        try {
          stored = await deps.objectStore.put({
            clientId: auth.clientId,
            kind: 'imports',
            body: req.body as Readable,
            contentType: 'text/csv',
            maxBytes: MAX_UPLOAD_BYTES,
            now,
          });
        } catch (err) {
          if (err instanceof ObjectTooLargeError) throw err;
          throw err;
        }

        const sniff = await sniffCsvHeader(await deps.objectStore.getStream(stored.key));
        const clientRow = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          tx.query<{ country_code: string }>(
            `SELECT country_code FROM clients WHERE id = $1 -- client_id = id = $1`,
            [auth.clientId],
          ),
        );
        const defaultCountry = clientRow.rows[0]?.country_code ?? 'IN';

        sendSuccess(
          reply,
          requestId,
          {
            storageKey: stored.key,
            bytes: stored.bytes,
            columns: sniff.columns,
            preview: sniff.preview,
            delimiter: sniff.delimiter,
            defaultCountry,
          },
          201,
        );
      } catch (err) {
        sendError(reply, requestId, err);
      }
    },
  });
}
