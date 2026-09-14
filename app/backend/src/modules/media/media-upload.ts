import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { assertAllowedMedia, extensionForMime, MEDIA_CAPS_BYTES, type MediaKind } from '@wp/domain';
import { insertOrGetMediaAsset, type MediaAssetRow } from './media.repo.js';
import type { TenantQueryable } from '@wp/db';
import { ObjectTooLargeError, type ObjectStore } from '../../platform/storage/object-store.js';

/**
 * media-upload.ts (P34 U-upload, ADR 0052 accepted scope) - the upload
 * service: validates kind/MIME/size (`@wp/domain#assertAllowedMedia`)
 * BEFORE storing, streams the body into `objectStore.put` (a hashing
 * `PassThrough` tees the SAME bytes to a running sha256 digest - never a
 * second read of the body), then inserts (or dedupes onto) the
 * `media_assets` row. The declared `contentType` is validated against the
 * per-kind MIME allow-list; this unit does NOT sniff magic bytes (out of
 * this dispatch's scope - the accepted-scope ADR section does not require
 * it, unlike the full ADR body's SS2.1).
 */

export class UnsupportedMediaKindError extends Error {
  readonly code = 'UNSUPPORTED_MEDIA_TYPE';
  readonly details: { mimeType: string; kind: MediaKind };
  constructor(mimeType: string, kind: MediaKind) {
    super(`MIME type ${mimeType} is not allowed for kind ${kind}.`);
    this.name = 'UnsupportedMediaKindError';
    this.details = { mimeType, kind };
  }
}

export class MediaTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE';
  readonly details: { maxBytes: number };
  constructor(maxBytes: number) {
    super(`Upload exceeds the ${String(maxBytes)}-byte cap for this kind.`);
    this.name = 'MediaTooLargeError';
    this.details = { maxBytes };
  }
}

export interface UploadMediaInput {
  clientId: string;
  kind: MediaKind;
  mimeType: string;
  fileName: string | null;
  body: Readable;
  createdByUserId: string | null;
}

export interface UploadMediaDeps {
  objectStore: ObjectStore;
  now?: () => Date;
}

/**
 * Tees `source` through a hashing `Transform`, accumulating a running
 * sha256 as each chunk passes through - the SAME bytes flow onward to
 * `objectStore.put`, never read twice. Deliberately a `Transform` (whose
 * `_transform` hashes AND forwards the chunk in the SAME callback), never a
 * `PassThrough` plus a separate `.on('data', ...)` listener - attaching a
 * second, independent data listener puts a stream into flowing mode
 * immediately and drains it before `put()`'s own internal pipeline ever
 * attaches its consumer, so the object store would see zero bytes (a real
 * bug this comment now documents against reintroduction - caught by
 * `media-upload.test.ts`'s own size assertion).
 */
function hashingTransform(source: Readable): { stream: Transform; digest: () => Buffer } {
  const hash = createHash('sha256');
  const stream = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  source.pipe(stream);
  return { stream, digest: () => hash.digest() };
}

/**
 * Validates kind/MIME/size, streams the body into the object store under a
 * hard byte cap (leaving no partial object on overflow - `ObjectStore.put`'s
 * own guarantee), computes sha256 while streaming, and inserts-or-dedupes
 * the `media_assets` row. Throws `UnsupportedMediaKindError` /
 * `MediaTooLargeError` before ANY byte reaches the object store when the
 * MIME is rejected outright; a size violation mid-stream surfaces as
 * `ObjectTooLargeError` from `put()` itself (already leaves no partial
 * object - `object-store-fs.ts`/`object-store-s3.ts`'s own guarantee).
 */
export async function uploadMedia(
  tx: TenantQueryable,
  deps: UploadMediaDeps,
  input: UploadMediaInput,
): Promise<MediaAssetRow> {
  const mimeCheck = assertAllowedMedia({
    kind: input.kind,
    mimeType: input.mimeType,
    // Only the MIME is knowable before the body streams - the byte-size arm
    // of assertAllowedMedia is re-checked structurally by put()'s own
    // maxBytes cap below; this call exists to reject a bad MIME BEFORE any
    // byte is written.
    sizeBytes: 0,
  });
  if (!mimeCheck.ok && mimeCheck.error.code === 'UNSUPPORTED_MEDIA_TYPE') {
    throw new UnsupportedMediaKindError(input.mimeType, input.kind);
  }

  const maxBytes = MEDIA_CAPS_BYTES[input.kind];
  const now = deps.now?.() ?? new Date();
  const id = randomUUID();
  const { stream: hashed, digest } = hashingTransform(input.body);

  let stored;
  try {
    stored = await deps.objectStore.put({
      clientId: input.clientId,
      kind: 'media',
      body: hashed,
      contentType: input.mimeType as Parameters<ObjectStore['put']>[0]['contentType'],
      maxBytes,
      now,
      id,
    });
  } catch (err) {
    if (err instanceof ObjectTooLargeError) {
      throw new MediaTooLargeError(maxBytes);
    }
    throw err;
  }

  return insertOrGetMediaAsset(tx, {
    clientId: input.clientId,
    id,
    kind: input.kind,
    mimeType: input.mimeType,
    sizeBytes: stored.bytes,
    fileName: input.fileName,
    storageKey: stored.key,
    sha256: digest(),
    createdByUserId: input.createdByUserId,
  });
}

/** Re-exported so callers never need `extensionForMime` from `@wp/domain` directly just to build a filename fallback. */
export { extensionForMime };
