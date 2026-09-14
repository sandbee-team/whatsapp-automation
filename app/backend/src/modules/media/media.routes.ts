import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { TenantDb } from '@wp/db';
import { getMediaOutputSchema, mediaIdParamSchema, uploadMediaOutputSchema } from '@wp/contracts';
import { MEDIA_KINDS, MEDIA_MIME_ALLOW_LIST, type MediaKind } from '@wp/domain';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import type { ObjectStore } from '../../platform/storage/object-store.js';
import { uploadMedia } from './media-upload.js';
import { getMediaAssetById, type MediaAssetRow } from './media.repo.js';

/**
 * media.routes.ts (P34 U-upload, ADR 0052 accepted scope) - `POST /v1/media`
 * (single-file raw stream, same shape as `import-upload.routes.ts` - see
 * that file's header for why: `Content-Type` carries the MIME directly, the
 * body is streamed straight into `uploadMedia`, never buffered whole in
 * this route) and `GET /v1/media/:id` (metadata only, never the bytes or
 * the storage key - ADR 0052 accepted item 2).
 *
 * `kind` and `fileName` are NOT part of the body (there is no JSON body at
 * all - the whole request body IS the file) - modelled as route-local query
 * parameters, the same "route-local zod schema, not the shared oRPC
 * contract" shape `messages.routes-support.ts#messageQuerySchema`
 * establishes for a param that belongs to the transport, not the payload
 * contract.
 *
 * `POST /v1/media` policy `session_or_api_key` (go-live U3): an API-key
 * principal MAY upload (`req.apiKeyAuth`), same as `POST /v1/messages` -
 * this route is added to `scripts/check-api-key-routes.ts`'s allow-list in
 * this same unit. `GET /v1/media/:id` stays `session`-only (metadata read
 * has no API-key use case in this accepted scope), so `principalFrom`'s
 * `req.apiKeyAuth` branch is dead code on that route by construction.
 */

export interface MediaRoutesDeps {
  tenantDb: TenantDb;
  objectStore: ObjectStore;
  now?: () => Date;
}

const uploadQuerySchema = z.object({
  kind: z.enum(MEDIA_KINDS),
  fileName: z.string().trim().min(1).max(200).optional(),
});

class ValidationMappedError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationMappedError';
  }
}

export class MediaNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No media asset with this id exists for your account.');
    this.name = 'MediaNotFoundError';
  }
}

function toWire(row: MediaAssetRow) {
  return {
    id: row.id,
    kind: row.kind,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    fileName: row.fileName,
    createdAt: row.createdAt,
  };
}

/** Resolves the acting principal for `session_or_api_key` - either the api_key populated by `route-policy.ts`'s key-authenticated branch, or the human session. Kept local (never imported from `modules/messages`, a different unit's scope) - same shape as that module's own `principalFrom`. */
function principalFrom(req: {
  apiKeyAuth?: { clientId: string; createdByUserId: string };
  auth?: { clientId: string; userId: string };
}): { clientId: string; createdByUserId: string | null } {
  if (req.apiKeyAuth) {
    return { clientId: req.apiKeyAuth.clientId, createdByUserId: req.apiKeyAuth.createdByUserId };
  }
  const auth = req.auth!;
  return { clientId: auth.clientId, createdByUserId: auth.userId };
}

export function registerMediaRoutes(
  app: FastifyInstance,
  deps: MediaRoutesDeps,
  authDeps: AuthDeps,
): void {
  const allowedContentTypes = [
    ...new Set([...MEDIA_MIME_ALLOW_LIST.image, ...MEDIA_MIME_ALLOW_LIST.document]),
  ];
  for (const contentType of allowedContentTypes) {
    if (!app.hasContentTypeParser(contentType)) {
      app.addContentTypeParser(
        contentType,
        (_req, payload: Readable, done: (err: Error | null, body?: unknown) => void) => {
          done(null, payload);
        },
      );
    }
  }

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/media',
    policy: 'session_or_api_key',
    scope: 'media:upload',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const principal = principalFrom(req);
        const query = uploadQuerySchema.safeParse(req.query);
        if (!query.success) {
          throw new ValidationMappedError(
            'A valid kind query parameter (image|document) is required.',
          );
        }
        const kind: MediaKind = query.data.kind;

        const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
        if (!MEDIA_MIME_ALLOW_LIST[kind].includes(contentType)) {
          const err = new Error(`Content-Type ${contentType} is not allowed for kind ${kind}.`);
          (err as { code?: string }).code = 'UNSUPPORTED_MEDIA_TYPE';
          throw err;
        }

        const result = await deps.tenantDb.withTenant(principal.clientId, (tx) =>
          uploadMedia(
            tx,
            { objectStore: deps.objectStore, now: deps.now },
            {
              clientId: principal.clientId,
              kind,
              mimeType: contentType,
              fileName: query.data.fileName ?? null,
              body: req.body as Readable,
              createdByUserId: principal.createdByUserId,
            },
          ),
        );

        const parsed = uploadMediaOutputSchema.shape.data.parse(toWire(result));
        sendSuccess(reply, requestId, parsed, 201);
      } catch (err) {
        sendError(reply, requestId, err);
      }
    },
  });

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/media/:id',
    policy: 'session',
    scope: 'media:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const principal = principalFrom(req);
        const { id } = mediaIdParamSchema.parse({ id: (req.params as { id: string }).id });

        const row = await deps.tenantDb.withTenant(principal.clientId, (tx) =>
          getMediaAssetById(tx, principal.clientId, id),
        );
        if (!row) throw new MediaNotFoundError();

        const parsed = getMediaOutputSchema.shape.data.parse(toWire(row));
        sendSuccess(reply, requestId, parsed);
      } catch (err) {
        sendError(reply, requestId, err);
      }
    },
  });
}
