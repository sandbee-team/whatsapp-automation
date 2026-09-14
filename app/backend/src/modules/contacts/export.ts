import type { TenantDb } from '@wp/db';
import { loadTagsByContactId } from './contacts-tags-lookup.js';

/**
 * export.ts (P20 Unit U6, step 7) - the tenant contacts CSV export. Two
 * pieces: `escapeCsvCell` (pure, RFC 4180 quoting + formula-injection
 * defence) and `streamContactsCsv` (a bounded-memory async generator,
 * keyset-paginated over `(updated_at DESC, id DESC)`, one `withTenant` per
 * page - NEVER a full materialisation, NEVER `OFFSET`).
 *
 * Formula-injection defence: a raw cell value starting with `=`, `+`, `-`,
 * `@`, tab, or CR is a live formula/command trigger in Excel/Sheets/LibreOffice
 * when a CSV is opened there - prefixing it with a literal `'` (as Excel's own
 * own "Text" import convention does) neutralises it while keeping the
 * original value visible. This runs BEFORE RFC 4180 quoting so the prefixed
 * value is itself quoted (a leading `'` is not, by itself, a reason to quote
 * under RFC 4180 - the prefix is what forces quoting downstream via its own
 * embedded quote-trigger check below).
 */

const FORMULA_TRIGGER_PATTERN = /^[=+\-@\t\r]/;

/** RFC 4180 quoting: a cell is quoted when it contains `"`, `,`, `\n`, `\r`, or leading/trailing whitespace. */
function needsQuoting(value: string): boolean {
  return (
    value.includes('"') ||
    value.includes(',') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value !== value.trim()
  );
}

/**
 * Escapes one CSV cell: `null`/`undefined` become an empty string; a value
 * starting with a formula-injection trigger character is prefixed with `'`
 * FIRST (so the prefixed form is what gets quoted below); embedded `"` is
 * doubled; the cell is wrapped in `"..."` whenever RFC 4180 requires it.
 */
export function escapeCsvCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';

  const isFormulaGuarded = FORMULA_TRIGGER_PATTERN.test(value);
  const guarded = isFormulaGuarded ? `'${value}` : value;
  // A formula-guarded cell is ALWAYS quoted (never left bare), even when the
  // guarded text would otherwise not trigger RFC 4180 quoting on its own -
  // the leading `'` must survive round-tripping through a CSV reader intact.
  if (!isFormulaGuarded && !needsQuoting(guarded)) return guarded;

  return `"${guarded.replace(/"/g, '""')}"`;
}

const EXPORT_HEADER =
  'phone_e164,display_name,first_name,last_name,opt_out_state,opted_out_at,tags,created_at,updated_at,attrs_json';

interface ExportPageRow extends Record<string, unknown> {
  id: string;
  phone_e164: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  opt_out_state: 'none' | 'opted_out';
  opted_out_at: Date | null;
  attrs: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  /**
   * `updated_at`'s own microsecond-precision text (`updated_at::text`) -
   * the CURSOR value. A JS `Date` only carries millisecond precision, so
   * round-tripping the cursor through `Date#toISOString()` truncates
   * (never rounds) any real microsecond remainder; when many rows share
   * one statement's `now()` (e.g. a bulk import), that truncated cursor
   * compares LESS than the very row it came from, silently dropping every
   * row after the first page. Binding this raw text value instead keeps
   * the keyset comparison exact.
   */
  updated_at_cursor: string;
}

function toCsvLine(row: ExportPageRow, tagNames: string[]): string {
  return [
    escapeCsvCell(row.phone_e164),
    escapeCsvCell(row.display_name),
    escapeCsvCell(row.first_name),
    escapeCsvCell(row.last_name),
    escapeCsvCell(row.opt_out_state),
    escapeCsvCell(row.opted_out_at ? row.opted_out_at.toISOString() : null),
    escapeCsvCell(tagNames.join(';')),
    escapeCsvCell(row.created_at.toISOString()),
    escapeCsvCell(row.updated_at.toISOString()),
    escapeCsvCell(JSON.stringify(row.attrs)),
  ].join(',');
}

export interface StreamContactsCsvDeps {
  tenantDb: TenantDb;
}

export interface StreamContactsCsvInput {
  clientId: string;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 1000;

/**
 * Yields the CSV header, then one line per live contact, oldest-to-newest
 * update order reversed (DESC) - keyset over `(updated_at, id)`, page size
 * `pageSize` (default 1000). EACH page runs in its own `tenantDb.withTenant`
 * call (bounded memory: at most one page's rows are ever held at once).
 * Never `OFFSET`.
 */
export async function* streamContactsCsv(
  deps: StreamContactsCsvDeps,
  input: StreamContactsCsvInput,
): AsyncGenerator<string> {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  yield EXPORT_HEADER + '\n';

  let cursor: { updatedAt: string; id: string } | undefined;

  for (;;) {
    const page = await deps.tenantDb.withTenant(input.clientId, async (tx) => {
      const params: unknown[] = [input.clientId];
      let cursorClause = '';
      if (cursor) {
        params.push(cursor.updatedAt, cursor.id);
        cursorClause = ` AND (updated_at, id) < ($${String(params.length - 1)}::timestamptz, $${String(params.length)}::uuid)`;
      }
      params.push(pageSize);

      const result = await tx.query<ExportPageRow>(
        `SELECT id, phone_e164, display_name, first_name, last_name, opt_out_state,
                opted_out_at, attrs, created_at, updated_at, updated_at::text AS updated_at_cursor
           FROM contacts
          WHERE client_id = $1 AND deleted_at IS NULL${cursorClause}
          -- client_id = $1
          ORDER BY updated_at DESC, id DESC
          LIMIT $${String(params.length)}`,
        params,
      );

      const tagsByContact = await loadTagsByContactId(
        tx,
        input.clientId,
        result.rows.map((r) => r.id),
      );
      return result.rows.map((row) => ({
        row,
        tagNames: (tagsByContact.get(row.id) ?? []).map((t) => t.name),
      }));
    });

    if (page.length === 0) return;

    for (const { row, tagNames } of page) {
      yield toCsvLine(row, tagNames) + '\n';
    }

    const last = page.at(-1)!.row;
    cursor = { updatedAt: last.updated_at_cursor, id: last.id };
  }
}
