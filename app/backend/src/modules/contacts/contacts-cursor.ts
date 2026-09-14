/**
 * contacts-cursor.ts (P20 Unit U4, step 4) - the contacts list's opaque
 * keyset cursor codec, split out of `contacts.repo.ts` for the 300-line cap
 * (`session-worker-discovery-wiring.ts`'s own split idiom). Same shape as
 * `modules/notifications/notifications.repo.ts`'s `encodeCursor`/
 * `decodeCursor`, keyed on `(updatedAt, id)` instead of `(createdAt, id)`.
 */

export class InvalidCursorError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor() {
    super('Invalid pagination cursor.');
    this.name = 'InvalidCursorError';
  }
}

interface DecodedCursor {
  updatedAt: string;
  id: string;
}

/** RFC-4122-ish UUID shape (any version) - matches `z.string().uuid()`'s own pattern intent. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encodes an opaque, server-issued cursor from the LAST row of a page - never a client-constructed offset. */
export function encodeCursor(input: DecodedCursor): string {
  return Buffer.from(`${input.updatedAt}|${input.id}`, 'utf8').toString('base64url');
}

/** Decodes a cursor previously produced by `encodeCursor` - throws `InvalidCursorError` on any malformed input. */
export function decodeCursor(cursor: string): DecodedCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError();
  }
  const sepIndex = decoded.indexOf('|');
  if (sepIndex <= 0 || sepIndex === decoded.length - 1) {
    throw new InvalidCursorError();
  }
  const updatedAt = decoded.slice(0, sepIndex);
  const id = decoded.slice(sepIndex + 1);
  if (Number.isNaN(Date.parse(updatedAt))) {
    throw new InvalidCursorError();
  }
  if (!UUID_PATTERN.test(id)) {
    throw new InvalidCursorError();
  }
  return { updatedAt, id };
}
