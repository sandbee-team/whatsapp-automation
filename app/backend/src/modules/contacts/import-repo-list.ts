import type { TenantQueryable } from '@wp/db';
import {
  IMPORT_COLUMNS,
  mapImportRow,
  type ContactImportRow,
  type RawImportRow,
} from './import-repo-row.js';

/**
 * import-repo-list.ts (P20 Unit U5, step 5) - the keyset list halves of the
 * `contact_imports`/`contact_import_errors` repo, split out of
 * `import.repo.ts` purely for that file's own max-lines cap (same split
 * idiom as `session-worker-discovery-wiring.ts`). Re-exported from
 * `import.repo.ts` so callers still have one import surface.
 *
 * KEYSET ONLY, no OFFSET anywhere (canon, same discipline as
 * `contacts.repo.ts`).
 */

/** A malformed import-list cursor - maps to 400 VALIDATION_ERROR via `sendError`'s typed-error path (m1; matches `contacts-cursor.ts#InvalidCursorError`'s shape). */
export class InvalidImportCursorError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor() {
    super('Invalid pagination cursor.');
    this.name = 'InvalidImportCursorError';
  }
}

export interface ListContactImportsInput {
  clientId: string;
  limit: number;
  cursor?: string;
}

export interface ListContactImportsResult {
  items: ContactImportRow[];
  nextCursor: string | null;
}

interface DecodedImportCursor {
  createdAt: string;
  id: string;
}

/** RFC-4122-ish UUID shape (any version) - same pattern intent as `contacts-cursor.ts` (m1). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encodes an opaque, server-issued cursor from the LAST row of a page. */
function encodeImportCursor(input: DecodedImportCursor): string {
  return Buffer.from(`${input.createdAt}|${input.id}`, 'utf8').toString('base64url');
}

/** Decodes a cursor previously produced by `encodeImportCursor`. */
function decodeImportCursor(cursor: string): DecodedImportCursor {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const sepIndex = decoded.indexOf('|');
  if (sepIndex <= 0 || sepIndex === decoded.length - 1) {
    throw new InvalidImportCursorError();
  }
  const createdAt = decoded.slice(0, sepIndex);
  const id = decoded.slice(sepIndex + 1);
  if (Number.isNaN(Date.parse(createdAt)) || !UUID_PATTERN.test(id)) {
    throw new InvalidImportCursorError();
  }
  return { createdAt, id };
}

/** Keyset list on `(created_at, id)` DESC - no OFFSET anywhere. */
export async function listContactImports(
  tx: TenantQueryable,
  input: ListContactImportsInput,
): Promise<ListContactImportsResult> {
  const cursor = input.cursor ? decodeImportCursor(input.cursor) : undefined;
  const params: unknown[] = [input.clientId];
  let cursorClause = '';
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    cursorClause = ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(input.limit + 1);

  const result = await tx.query<RawImportRow>(
    `SELECT ${IMPORT_COLUMNS} FROM contact_imports
      WHERE client_id = $1${cursorClause}
      -- client_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > input.limit;
  const page = hasMore ? result.rows.slice(0, input.limit) : result.rows;
  const items = page.map(mapImportRow);
  const last = items.at(-1);
  const nextCursor =
    hasMore && last ? encodeImportCursor({ createdAt: last.createdAt, id: last.id }) : null;

  return { items, nextCursor };
}

export interface ImportErrorRow {
  rowNo: number;
  reason: string;
  rawExcerpt: string | null;
}

export interface ListImportErrorsInput {
  clientId: string;
  importId: string;
  afterRowNo?: number;
  limit: number;
}

interface RawImportErrorRow extends Record<string, unknown> {
  row_no: string | number;
  reason: string;
  raw_excerpt: string | null;
}

/**
 * Keyset list of retained error rows on `row_no` ASC - no OFFSET. Excludes
 * `row_no = 0` (M3's reserved import-LEVEL terminal-reason sentinel - it is
 * not a CSV record, so it is never part of the "errors" CSV a caller
 * downloads; the import's `lastErrorReason` surfaces it separately).
 */
export async function listImportErrors(
  tx: TenantQueryable,
  input: ListImportErrorsInput,
): Promise<ImportErrorRow[]> {
  const params: unknown[] = [input.clientId, input.importId];
  let afterClause = '';
  if (input.afterRowNo !== undefined) {
    params.push(input.afterRowNo);
    afterClause = ` AND row_no > $${params.length}`;
  }
  params.push(input.limit);

  const result = await tx.query<RawImportErrorRow>(
    `SELECT row_no, reason, raw_excerpt FROM contact_import_errors
      WHERE client_id = $1 AND import_id = $2 AND row_no > 0${afterClause}
      -- client_id = $1
      ORDER BY row_no ASC
      LIMIT $${params.length}`,
    params,
  );

  return result.rows.map((row) => ({
    rowNo: Number(row.row_no),
    reason: row.reason,
    rawExcerpt: row.raw_excerpt,
  }));
}
