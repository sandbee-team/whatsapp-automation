import type { Readable } from 'node:stream';

/**
 * object-store-types.ts (P20 Unit U3, step 5) - the shared public types, in
 * their own leaf module for the same circular-import reason as
 * `object-store-keys.ts` (see that file's header).
 */

/**
 * The object kinds that exist: the CSV import upload (P20) and the outbound
 * media upload pipeline (P34, ADR 0052 accepted scope - image/document
 * only). Widening this union is additive; each new kind needs its own
 * `contentType` members below and its own extension mapping in
 * `object-store-keys.ts`.
 */
export type ObjectKind = 'imports' | 'media';

/**
 * The closed MIME union `put()` accepts, spanning both kinds above. `media`
 * uploads are restricted further, per-kind, by `@wp/domain`'s
 * `MEDIA_MIME_ALLOW_LIST` (image: jpeg/png/webp; document: pdf + office/
 * text types) - this union is the OUTER bound the object-store type system
 * enforces; the caller (the media upload service) enforces the narrower,
 * per-kind allow-list before ever calling `put()`.
 */
export type ObjectContentType =
  | 'text/csv'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'application/pdf'
  | 'application/msword'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.ms-excel'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'text/plain';

export interface PutObjectInput {
  clientId: string;
  kind: ObjectKind;
  body: Readable;
  contentType: ObjectContentType;
  /** Hard byte cap - exceeding it aborts the write and leaves no partial object. */
  maxBytes: number;
  /** Injected clock (core invariants: no ambient wall-clock reads in a derivation). */
  now: Date;
  /** Injected id for deterministic tests; defaults to `randomUUID()`. */
  id?: string;
}

export interface StoredObject {
  key: string;
  bytes: number;
}

export interface ObjectHead {
  bytes: number;
  lastModified: Date;
}

export interface ObjectListing {
  key: string;
  bytes: number;
  lastModified: Date;
}

export interface ObjectStore {
  /** THE ONLY KEY BUILDER - see `object-store.ts`'s module doc. */
  put(input: PutObjectInput): Promise<StoredObject>;
  /** Throws `ObjectNotFoundError` when `key` is absent. */
  getStream(key: string): Promise<Readable>;
  head(key: string): Promise<ObjectHead | null>;
  /** Idempotent - deleting an absent key is not an error. */
  delete(key: string): Promise<void>;
  /** For the 30-day retention purge. */
  list(prefix: string, opts?: { olderThan?: Date; limit?: number }): AsyncIterable<ObjectListing>;
}

export class ObjectTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE';
  readonly details: { maxBytes: number };

  constructor(maxBytes: number) {
    super(`object exceeds the ${String(maxBytes)}-byte cap`);
    this.name = 'ObjectTooLargeError';
    this.details = { maxBytes };
  }
}

export class ObjectNotFoundError extends Error {
  readonly code = 'NOT_FOUND';

  constructor(key: string) {
    super(`object not found: ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}
