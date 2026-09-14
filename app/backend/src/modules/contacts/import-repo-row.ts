import type { ImportMapping } from './import-upload.js';

/**
 * import-repo-row.ts (P20 Unit U5, step 5) - the shared `contact_imports`
 * row shape/mapper/column list, split out of `import.repo.ts` purely for
 * that file's own max-lines cap (same split idiom as
 * `session-worker-discovery-wiring.ts`) - both `import.repo.ts` and its
 * `import-repo-list.ts` sibling need the identical row shape.
 */

export type ContactImportStatus =
  'uploaded' | 'validating' | 'importing' | 'done' | 'failed' | 'cancelled';

export interface ContactImportRow {
  id: string;
  clientId: string;
  filename: string | null;
  storageKey: string;
  mapping: ImportMapping;
  defaultCountry: string;
  applyTagIds: string[];
  attestationText: string;
  attestedByUserId: string;
  attestedAt: string;
  status: ContactImportStatus;
  cursorRow: number;
  totalRows: number | null;
  importedCount: number;
  updatedCount: number;
  invalidCount: number;
  duplicateCount: number;
  optedOutCount: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface RawImportRow extends Record<string, unknown> {
  id: string;
  client_id: string;
  filename: string | null;
  storage_key: string;
  mapping: ImportMapping;
  default_country: string;
  apply_tag_ids: string[];
  attestation_text: string;
  attested_by_user_id: string;
  attested_at: Date;
  status: ContactImportStatus;
  cursor_row: string | number;
  total_rows: number | null;
  imported_count: number;
  updated_count: number;
  invalid_count: number;
  duplicate_count: number;
  opted_out_count: number;
  created_at: Date;
  finished_at: Date | null;
}

export function mapImportRow(row: RawImportRow): ContactImportRow {
  return {
    id: row.id,
    clientId: row.client_id,
    filename: row.filename,
    storageKey: row.storage_key,
    mapping: row.mapping,
    defaultCountry: row.default_country,
    applyTagIds: row.apply_tag_ids,
    attestationText: row.attestation_text,
    attestedByUserId: row.attested_by_user_id,
    attestedAt: row.attested_at.toISOString(),
    status: row.status,
    cursorRow: Number(row.cursor_row),
    totalRows: row.total_rows,
    importedCount: row.imported_count,
    updatedCount: row.updated_count,
    invalidCount: row.invalid_count,
    duplicateCount: row.duplicate_count,
    optedOutCount: row.opted_out_count,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

export const IMPORT_COLUMNS = `id, client_id, filename, storage_key, mapping, default_country, apply_tag_ids,
       attestation_text, attested_by_user_id, attested_at, status, cursor_row, total_rows,
       imported_count, updated_count, invalid_count, duplicate_count, opted_out_count,
       created_at, finished_at`;
