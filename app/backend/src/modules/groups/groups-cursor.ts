/**
 * groups-cursor.ts (P24 Unit U3, step 4) - the group list's opaque keyset
 * cursor codec, split into its own file for the same reason
 * `contacts-cursor.ts` is: it is a small, self-contained concern.
 * `groups-list.sql` is ordered `(id) ASC` only (a single-column key, unlike
 * `contacts-cursor.ts`'s `(updatedAt, id)` pair) - a group has no natural
 * "recently changed" ordering the panel needs, so the simplest sufficient
 * cursor is the last row's own `id`.
 */

export class InvalidGroupCursorError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor() {
    super('Invalid pagination cursor.');
    this.name = 'InvalidGroupCursorError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encodes an opaque, server-issued cursor from the last row's `id` - never a client-constructed offset. */
export function encodeGroupCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

/** Decodes a cursor previously produced by `encodeGroupCursor` - throws `InvalidGroupCursorError` on any malformed input. */
export function decodeGroupCursor(cursor: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new InvalidGroupCursorError();
  }
  if (!UUID_PATTERN.test(decoded)) {
    throw new InvalidGroupCursorError();
  }
  return decoded;
}
