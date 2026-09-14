/**
 * platform/keyset.ts (P28 Unit U4, step 7) - the ONE cursor codec every
 * admin list read uses. Keyset pagination only: `OFFSET` is banned
 * repo-wide by eslint (`wp/no-offset-pagination`) and specifically asserted
 * absent from this project's sources by
 * `modules/clients/clients.read.integration.test.ts#admin_reads_are_keyset_paginated_and_never_use_offset`.
 *
 * Why keyset matters MORE on an admin surface than a tenant one: staff walk
 * these lists while the underlying tables are being written by the live
 * send path. An `OFFSET`-paginated walk over a moving table silently SKIPS
 * rows (a new row shifts everything down a page) and DUPLICATES others -
 * for a list a human is using to decide whether a workspace was suspended,
 * "silently skipped" is a correctness failure, not a cosmetic one. A
 * `(created_at, id)` keyset walk is stable under concurrent inserts:
 * every row that existed at the start of the walk is visited exactly once.
 *
 * The cursor is opaque base64 of `created_at|id` - opaque so a caller cannot
 * hand-craft one to reach into an arbitrary position, and so the tuple's
 * shape can change without a contract break. It is NOT authenticated: it
 * carries no authority (the staff token does), only a position, and every
 * read it feeds is already RBAC-checked and audited.
 */

export interface KeysetCursor {
  /** ISO-8601 `created_at` of the last row of the previous page. */
  createdAt: string;
  id: string;
}

export interface KeysetPage<T> {
  items: T[];
  /** `null` when this was the last page - a caller stops when it sees null, never by comparing counts. */
  nextCursor: string | null;
}

const CURSOR_SEPARATOR = '|';

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(`${cursor.createdAt}${CURSOR_SEPARATOR}${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * Decodes an opaque cursor, or returns `undefined` for absent/malformed
 * input. A malformed cursor is deliberately treated as "start from the
 * beginning" rather than an error: it can only ever narrow what the caller
 * sees (the read itself is already scoped and audited), and a 400 here
 * would turn a stale bookmarked admin URL into an error page.
 */
export function decodeCursor(raw: string | undefined | null): KeysetCursor | undefined {
  if (!raw) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  const separatorAt = decoded.indexOf(CURSOR_SEPARATOR);
  if (separatorAt <= 0) return undefined;
  const createdAt = decoded.slice(0, separatorAt);
  const id = decoded.slice(separatorAt + 1);
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) return undefined;
  return { createdAt, id };
}
