import type { TenantQueryable } from '@wp/db';
import { assertTenantKey } from '../../platform/storage/object-store.js';
import { provisioningRepo } from '../tenancy/index.js';
import { validateMapping, type ImportMapping } from './import-upload.js';
import {
  IMPORT_COLUMNS,
  mapImportRow,
  type ContactImportRow,
  type RawImportRow,
} from './import-repo-row.js';

/**
 * import.repo.ts (P20 Unit U5, step 5) - the `contact_imports` /
 * `contact_import_errors` / `consent_records` SQL-only repo. Every write
 * runs inside the CALLER's transaction (never opens its own, unlike
 * `contacts.repo.ts`'s `listContacts` which owns `tenantDb.withTenant`
 * itself) - `createContactImport` in particular must share ONE transaction
 * with its `consent_records` and `audit_logs` inserts (proved by
 * `attestation.integration.test.ts`'s same-transaction rollback case).
 *
 * The row shape/mapper (`import-repo-row.ts`) and the keyset list halves
 * (`import-repo-list.ts`) live in sibling modules purely for this file's own
 * max-lines cap - re-exported below so callers still have one import
 * surface.
 */

export {
  listContactImports,
  listImportErrors,
  type ImportErrorRow,
  type ListContactImportsInput,
  type ListContactImportsResult,
  type ListImportErrorsInput,
} from './import-repo-list.js';
export { type ContactImportRow, type ContactImportStatus } from './import-repo-row.js';

export class AttestationRequiredError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor() {
    super('An import requires a non-empty attestation of consent basis.');
    this.name = 'AttestationRequiredError';
  }
}

export class ImportMappingInvalidError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly details: { errors: string[] };
  constructor(errors: string[]) {
    super('The import mapping is invalid for the sniffed CSV columns.');
    this.name = 'ImportMappingInvalidError';
    this.details = { errors };
  }
}

export class ImportInvalidStateError extends Error {
  readonly code = 'CONFLICT';
  readonly details: { status: string };
  constructor(status: string) {
    super(`Import is in state "${status}" and cannot be cancelled.`);
    this.name = 'ImportInvalidStateError';
    this.details = { status };
  }
}

export interface CreateContactImportInput {
  clientId: string;
  filename: string | null;
  storageKey: string;
  mapping: ImportMapping;
  mappingColumns: string[];
  defaultCountry: string;
  applyTagIds: string[];
  attestationText: string;
  attestedByUserId: string;
  now: Date;
}

/**
 * Creates one `contact_imports` row plus its `consent_records` and
 * `audit_logs` companions, all in the CALLER's transaction. Throws
 * `AttestationRequiredError` for an empty/whitespace-only attestation and
 * `ImportMappingInvalidError` for a mapping that does not validate against
 * `mappingColumns`, OR for an `applyTagIds` entry that does not belong to
 * this tenant (addendum B - a foreign tag id must never even be accepted,
 * not merely silently excluded later by `applyTags`) - all BEFORE any
 * write, so a rejected attempt leaves zero rows anywhere (proved by
 * `an_import_without_an_attestation_never_runs`).
 */
export async function createContactImport(
  tx: TenantQueryable,
  input: CreateContactImportInput,
): Promise<ContactImportRow> {
  assertTenantKey(input.storageKey, input.clientId);

  const trimmedAttestation = input.attestationText.trim();
  if (trimmedAttestation.length < 3) {
    throw new AttestationRequiredError();
  }

  const mappingResult = validateMapping(input.mapping, input.mappingColumns);
  if (!mappingResult.ok) {
    throw new ImportMappingInvalidError(mappingResult.errors);
  }

  if (input.applyTagIds.length > 0) {
    const tagCheck = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM contact_tags WHERE client_id = $1 AND id = ANY($2::uuid[])`,
      [input.clientId, input.applyTagIds],
    );
    if (Number(tagCheck.rows[0]?.count ?? 0) !== input.applyTagIds.length) {
      throw new ImportMappingInvalidError([
        'applyTagIds contains a tag id that does not belong to this tenant',
      ]);
    }
  }

  const insertResult = await tx.query<RawImportRow>(
    `INSERT INTO contact_imports (
       client_id, filename, storage_key, mapping, default_country, apply_tag_ids,
       attestation_text, attested_by_user_id, attested_at, status
     )
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::uuid[], $7, $8, $9, 'uploaded')
     -- client_id = $1
     RETURNING ${IMPORT_COLUMNS}`,
    [
      input.clientId,
      input.filename,
      input.storageKey,
      JSON.stringify(input.mapping),
      input.defaultCountry,
      input.applyTagIds,
      trimmedAttestation,
      input.attestedByUserId,
      input.now,
    ],
  );
  const row = insertResult.rows[0];
  if (!row) {
    throw new Error('createContactImport: no row returned from INSERT');
  }

  await tx.query(
    `INSERT INTO consent_records
       (client_id, recipient_e164, basis, evidence_ref, source_note, captured_at, captured_by_user_id)
     VALUES ($1, NULL, 'imported_with_attestation', $2, $3, $4, $5)
     -- client_id = $1`,
    [
      input.clientId,
      `contact_import:${row.id}`,
      trimmedAttestation,
      input.now,
      input.attestedByUserId,
    ],
  );

  const auditMetadata = provisioningRepo.filterAuditMetadata({
    source: trimmedAttestation.slice(0, 200),
  });
  await tx.query(
    `INSERT INTO audit_logs (client_id, actor_type, actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1, 'user', $2, 'contacts.import.attested', 'contact_import', $3, $4)
     -- client_id = $1`,
    [
      input.clientId,
      input.attestedByUserId,
      row.id,
      auditMetadata ? JSON.stringify(auditMetadata) : null,
    ],
  );

  return mapImportRow(row);
}

/** Loads one `contact_imports` row - `undefined` when foreign or missing. */
export async function getContactImport(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<ContactImportRow | undefined> {
  const result = await tx.query<RawImportRow>(
    `SELECT ${IMPORT_COLUMNS} FROM contact_imports
      WHERE client_id = $1 AND id = $2
      -- client_id = $1`,
    [clientId, id],
  );
  const row = result.rows[0];
  return row ? mapImportRow(row) : undefined;
}

/** Conditionally cancels an import still in `uploaded`/`importing` - zero rows throws `ImportInvalidStateError`. */
export async function cancelContactImport(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<ContactImportRow> {
  const result = await tx.query<RawImportRow>(
    `UPDATE contact_imports SET status = 'cancelled', finished_at = now()
      WHERE client_id = $1 AND id = $2 AND status IN ('uploaded', 'importing')
      -- client_id = $1
      RETURNING ${IMPORT_COLUMNS}`,
    [clientId, id],
  );
  const row = result.rows[0];
  if (!row) {
    const existing = await getContactImport(tx, clientId, id);
    throw new ImportInvalidStateError(existing?.status ?? 'not_found');
  }
  return mapImportRow(row);
}

/**
 * The "clear error" reason shown for a failed import: the reserved `row_no
 * = 0` terminal reason (M3 - `import-runner-terminal.ts`) when present,
 * else the highest per-record `row_no`'s reason. `row_no = 0` always wins
 * because it is the import-LEVEL cause (`max_contacts_exceeded`,
 * `source_object_missing`, `parse_error`, `unexpected_error`) - a
 * coincidentally-higher per-record `row_no` must never shadow it.
 */
export async function lastErrorReason(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<string | undefined> {
  const result = await tx.query<{ reason: string }>(
    `SELECT reason FROM contact_import_errors
      WHERE client_id = $1 AND import_id = $2
      -- client_id = $1
      ORDER BY (row_no = 0) DESC, row_no DESC
      LIMIT 1`,
    [clientId, id],
  );
  return result.rows[0]?.reason;
}
