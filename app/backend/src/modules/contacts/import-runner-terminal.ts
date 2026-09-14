import type { TenantDb, TenantQueryable } from '@wp/db';
import { ObjectNotFoundError } from '../../platform/storage/object-store.js';

/**
 * import-runner-terminal.ts (P20 C1 M1/M3) - the closed set of import-LEVEL
 * terminal failure reasons (as opposed to `InvalidReason`, the per-RECORD
 * classification union in `import-runner-parse.ts`), plus the fresh-
 * transaction helper that marks one import `failed` after its own batch
 * transaction has already rolled back. Split out of `import-runner.ts`
 * purely for that file's own max-lines cap.
 *
 * Every terminal reason is written at the reserved sentinel `row_no = 0`
 * (CSV records start at 1) via `insertErrorRows`' `ON CONFLICT ... DO
 * UPDATE` path (`import-runner-batch.ts`) so it ALWAYS lands, even if a
 * genuine per-record error already claimed `row_no = cursor_row + 1` in a
 * PRIOR attempt - never silently dropped by a `DO NOTHING` collision (M3).
 */
export const TERMINAL_IMPORT_REASONS = [
  'max_contacts_exceeded',
  'source_object_missing',
  'parse_error',
  'unexpected_error',
] as const;
export type TerminalImportReason = (typeof TERMINAL_IMPORT_REASONS)[number];

/** A csv-parse error carries a `code` starting with `CSV_` - never matched on `.message` (row values may appear there). */
function isCsvParseError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('CSV_')
  );
}

/** Classifies an unhandled per-client batch failure into one of the closed terminal reasons - never the raw error message (pg/csv messages can carry row values). */
export function classifyImportFailure(err: unknown): TerminalImportReason {
  if (err instanceof ObjectNotFoundError) return 'source_object_missing';
  if (isCsvParseError(err)) return 'parse_error';
  return 'unexpected_error';
}

/**
 * Writes/overwrites the row-0 terminal error row for `importId` - the ONLY
 * writer of `row_no = 0` in the whole module. `ON CONFLICT ... DO UPDATE`
 * (never `DO NOTHING`, unlike every per-record insert) so the terminal
 * reason ALWAYS lands even if a prior attempt already wrote a different
 * terminal reason at this same sentinel row.
 */
export async function insertTerminalErrorRow(
  tx: TenantQueryable,
  input: { clientId: string; importId: string; reason: TerminalImportReason },
): Promise<void> {
  await tx.query(
    `INSERT INTO contact_import_errors (import_id, client_id, row_no, reason, raw_excerpt)
     VALUES ($1, $2, 0, $3, NULL)
     -- client_id = $2
     ON CONFLICT (import_id, row_no) DO UPDATE SET reason = EXCLUDED.reason`,
    [input.importId, input.clientId, input.reason],
  );
}

/**
 * Marks `importId` `failed` (conditional on it still being claimable) in a
 * FRESH `tenantDb.withTenant` transaction - the batch transaction that hit
 * `err` has already rolled back, so this never reuses that connection/tx.
 * Writes the row-0 terminal error row in the SAME fresh transaction. A
 * no-op (zero rows updated) when the import already left `uploaded`/
 * `importing` by the time this runs (e.g. cancelled concurrently) - the
 * error row is still written for visibility, harmlessly orphaned.
 */
export async function markImportFailedInFreshTx(
  tenantDb: TenantDb,
  clientId: string,
  importId: string,
  reason: TerminalImportReason,
): Promise<void> {
  await tenantDb.withTenant(clientId, async (tx) => {
    await tx.query(
      `UPDATE contact_imports SET status = 'failed', finished_at = now()
        WHERE client_id = $1 AND id = $2 AND status IN ('uploaded', 'importing')
        -- client_id = $1`,
      [clientId, importId],
    );
    await insertTerminalErrorRow(tx, { clientId, importId, reason });
  });
}
