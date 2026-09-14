import { randomUUID } from 'node:crypto';
import type { ObjectContentType, ObjectKind, PutObjectInput } from './object-store-types.js';

/**
 * object-store-keys.ts (P20 Unit U3, step 5) - the tenant-key assertion and
 * canonical key builder, split into their own leaf module so
 * `object-store.ts`, `object-store-fs.ts` and `object-store-s3.ts` can all
 * import them without a circular import (the three driver-facing files each
 * need `assertTenantKey`/`buildImportObjectKey`, and `object-store.ts` needs
 * to re-export the drivers - keeping the key logic here breaks that cycle).
 */

export class ForeignObjectKeyError extends Error {
  readonly code = 'FORBIDDEN';

  constructor(key: string) {
    super(`key does not belong to the calling tenant: ${key}`);
    this.name = 'ForeignObjectKeyError';
  }
}

/** One path segment: letters, digits, dot, underscore, hyphen only - no traversal shapes. */
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Throws `ForeignObjectKeyError` unless `key`'s SHAPE is safe: no `..`, no
 * backslash, no leading slash, no segment outside `[A-Za-z0-9._-]` - path-
 * traversal hardening (core invariant 4). Checks SHAPE ONLY, never tenancy
 * (m2) - a well-formed key belonging to a DIFFERENT tenant passes this
 * check; `assertTenantKey` (below) is the ONLY function that also checks
 * the `clients/${clientId}/` prefix, and callers that need tenant isolation
 * (never the drivers themselves - see `object-store.ts`'s module doc) must
 * call THAT one.
 */
export function assertSafeKeyShape(key: string): void {
  if (key.includes('\\') || key.startsWith('/') || key.includes('..')) {
    throw new ForeignObjectKeyError(key);
  }

  for (const segment of key.split('/')) {
    if (segment.length === 0 || !SAFE_SEGMENT_PATTERN.test(segment)) {
      throw new ForeignObjectKeyError(key);
    }
  }
}

/**
 * Throws `ForeignObjectKeyError` unless `key` has a safe SHAPE
 * (`assertSafeKeyShape`) AND starts with `clients/${clientId}/` - the
 * TENANCY check, core invariant 4. Every CALLER that needs tenant isolation
 * (`import.routes.ts`, `import.repo.ts`, `import-runner.ts`, the retention
 * purge) calls this, never `assertSafeKeyShape` alone - see this module's
 * own header and `object-store.ts`'s.
 */
export function assertTenantKey(key: string, clientId: string): void {
  assertSafeKeyShape(key);

  const expectedPrefix = `clients/${clientId}/`;
  if (!key.startsWith(expectedPrefix)) {
    throw new ForeignObjectKeyError(key);
  }
}

/** The imports prefix for `clientId` - `list()`'s natural scan root for the retention purge. */
export function importsPrefix(clientId: string): string {
  return `clients/${clientId}/imports/`;
}

/** The media prefix for `clientId` - `list()`'s natural scan root for the media retention sweep. */
export function mediaPrefix(clientId: string): string {
  return `clients/${clientId}/media/`;
}

const CLIENT_ID_PATTERN = /^[0-9a-f-]{36}$/i;

/**
 * The file extension for each object key, keyed by content type. `imports`
 * always writes `.csv` (unchanged from P20, `contentType` is always
 * `'text/csv'` on that path); `media` derives its extension from the
 * uploaded content type instead of a hard-coded literal (P34, ADR 0052) -
 * this map is intentionally NOT `@wp/domain`'s `extensionForMime` (that one
 * is scoped to the domain-level `MEDIA_MIME_ALLOW_LIST`, browser-safe with
 * no Node import; this file is the object-store's OWN key-shape authority
 * and must keep working for `text/csv` too, which is outside that map).
 */
const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<ObjectContentType, string>> = {
  'text/csv': 'csv',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
};

/**
 * Builds the canonical object key for a `put()` call - the ONLY place a key
 * is ever constructed (module doc, `object-store.ts`). `clientId` must look
 * like a UUID. The extension is derived from `contentType` (never
 * hard-coded), so `kind: 'media'` never collides with the `imports` shape.
 */
export function buildImportObjectKey(input: PutObjectInput): string {
  if (!CLIENT_ID_PATTERN.test(input.clientId)) {
    throw new TypeError(`clientId must be a UUID: ${input.clientId}`);
  }

  const yyyy = String(input.now.getUTCFullYear());
  const mm = String(input.now.getUTCMonth() + 1).padStart(2, '0');
  const uuid = input.id ?? randomUUID();
  const kind: ObjectKind = input.kind;
  const ext = EXTENSION_BY_CONTENT_TYPE[input.contentType];

  return `clients/${input.clientId}/${kind}/${yyyy}/${mm}/${uuid}.${ext}`;
}
