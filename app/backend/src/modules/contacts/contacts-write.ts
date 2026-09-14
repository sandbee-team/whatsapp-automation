import type { TenantQueryable } from '@wp/db';
import { normaliseE164, waJidFromE164, type ConsentBasis } from '@wp/domain';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import { assertUnderContactLimit } from './contacts-limits.js';
import { loadTagsByContactId } from './contacts-tags-lookup.js';
import {
  CONTACT_COLUMNS,
  mapContactRow,
  type ContactRow,
  type RawContactRow,
} from './contacts-row.js';

/**
 * contacts-write.ts (P20 Unit U4, step 4) - `createContact`/`updateContact`,
 * split out of `contacts.repo.ts` for the 300-line cap
 * (`session-worker-discovery-wiring.ts`'s own split idiom).
 */

export class ContactValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ContactValidationError';
  }
}

export class ContactDuplicatePhoneError extends Error {
  readonly code = 'CONFLICT';
  readonly details: { contactId: string };
  constructor(contactId: string) {
    super('A contact with this phone number already exists.');
    this.name = 'ContactDuplicatePhoneError';
    this.details = { contactId };
  }
}

export interface CreateContactRepoInput {
  clientId: string;
  createdByUserId: string;
  phone: string;
  defaultCountry?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  attrs?: Record<string, unknown>;
  consentBasis?: ConsentBasis;
  keyProvider: KeyProvider;
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505' &&
    (err as { constraint?: unknown }).constraint === constraint
  );
}

function isCheckViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23514' &&
    (err as { constraint?: unknown }).constraint === constraint
  );
}

/** Looks up the existing live contact for `(clientId, phoneE164)` - used to build a duplicate error's `details.contactId`. */
async function findLiveContactIdByPhone(
  tx: TenantQueryable,
  clientId: string,
  phoneE164: string,
): Promise<string | undefined> {
  const result = await tx.query<{ id: string }>(
    `SELECT id FROM contacts WHERE client_id = $1 AND phone_e164 = $2 AND deleted_at IS NULL`,
    [clientId, phoneE164],
  );
  return result.rows[0]?.id;
}

/**
 * Creates one contact. The `opt_out_state`/`opted_out_at` mirror is derived
 * in the SAME INSERT statement (never a separate read) from any unrestored
 * `opt_outs` row at any scope for this recipient - see migration 0060's own
 * header on why this column is a mirror only, never the send gate.
 */
export async function createContact(
  tx: TenantQueryable,
  input: CreateContactRepoInput,
): Promise<ContactRow> {
  await assertUnderContactLimit(tx, input.clientId);

  const clientRow = await tx.query<{ country_code: string }>(
    `SELECT country_code FROM clients WHERE id = $1 -- client_id = id = $1`,
    [input.clientId],
  );
  const defaultCountry = input.defaultCountry ?? clientRow.rows[0]?.country_code ?? 'IN';

  const normalised = normaliseE164(input.phone, defaultCountry);
  if (!normalised.ok) {
    throw new ContactValidationError(`Invalid phone number: ${normalised.reason}`);
  }
  const e164 = normalised.e164;
  const waJid = waJidFromE164(e164);
  const phoneHash = hashRecipient(input.keyProvider, e164);

  // A failed INSERT aborts the surrounding Postgres transaction (any
  // further statement errors `25P02` "current transaction is aborted"
  // until a ROLLBACK/ROLLBACK TO SAVEPOINT runs) - the duplicate-phone
  // lookup below needs a LIVE transaction to run in, so the INSERT is
  // scoped to its own SAVEPOINT (same idiom as signup.service.ts's own
  // `slug_try` savepoint) rather than the whole caller transaction.
  await tx.query('SAVEPOINT create_contact_try');
  let result;
  try {
    result = await tx.query<RawContactRow>(
      `INSERT INTO contacts (
         client_id, phone_e164, phone_hash, wa_jid, display_name, first_name, last_name,
         attrs, source, consent_basis, opt_out_state, opted_out_at, created_by_user_id
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'manual', $9,
              CASE WHEN EXISTS (
                SELECT 1 FROM opt_outs o
                 WHERE o.client_id = $1 AND o.phone_hash = $3 AND o.restored_at IS NULL
              ) THEN 'opted_out'::contact_opt_out_state ELSE 'none'::contact_opt_out_state END,
              (SELECT min(o.created_at) FROM opt_outs o
                WHERE o.client_id = $1 AND o.phone_hash = $3 AND o.restored_at IS NULL),
              $10
       -- client_id = $1
       RETURNING ${CONTACT_COLUMNS}`,
      [
        input.clientId,
        e164,
        phoneHash,
        waJid,
        input.displayName ?? null,
        input.firstName ?? null,
        input.lastName ?? null,
        JSON.stringify(input.attrs ?? {}),
        input.consentBasis ?? null,
        input.createdByUserId,
      ],
    );
    await tx.query('RELEASE SAVEPOINT create_contact_try');
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT create_contact_try');
    if (isUniqueViolation(err, 'contacts_client_phone_uq')) {
      const existingId = await findLiveContactIdByPhone(tx, input.clientId, e164);
      throw new ContactDuplicatePhoneError(existingId ?? '');
    }
    if (isCheckViolation(err, 'contacts_attrs_max_2048')) {
      throw new ContactValidationError('attrs exceed 2048 bytes');
    }
    throw err;
  }

  const row = result.rows[0];
  if (!row) {
    throw new Error('createContact: no row returned from INSERT');
  }
  return mapContactRow(row, []);
}

export interface UpdateContactRepoInput {
  clientId: string;
  id: string;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  attrs?: Record<string, unknown>;
}

/** Merges `attrs` (`contacts.attrs || $attrs`, then `jsonb_strip_nulls` to let a provided `null` value remove that key). Only provided fields are written. */
export async function updateContact(
  tx: TenantQueryable,
  input: UpdateContactRepoInput,
): Promise<ContactRow | undefined> {
  const setClauses: string[] = [];
  const params: unknown[] = [input.clientId, input.id];

  if (input.displayName !== undefined) {
    params.push(input.displayName);
    setClauses.push(`display_name = $${params.length}`);
  }
  if (input.firstName !== undefined) {
    params.push(input.firstName);
    setClauses.push(`first_name = $${params.length}`);
  }
  if (input.lastName !== undefined) {
    params.push(input.lastName);
    setClauses.push(`last_name = $${params.length}`);
  }
  if (input.attrs !== undefined) {
    params.push(JSON.stringify(input.attrs));
    setClauses.push(`attrs = jsonb_strip_nulls(attrs || $${params.length}::jsonb)`);
  }
  setClauses.push('updated_at = now()');

  let result;
  try {
    result = await tx.query<RawContactRow>(
      `UPDATE contacts SET ${setClauses.join(', ')}
        WHERE client_id = $1 AND id = $2 AND deleted_at IS NULL
        -- client_id = $1
      RETURNING ${CONTACT_COLUMNS}`,
      params,
    );
  } catch (err) {
    if (isCheckViolation(err, 'contacts_attrs_max_2048')) {
      throw new ContactValidationError('attrs exceed 2048 bytes');
    }
    throw err;
  }

  const row = result.rows[0];
  if (!row) return undefined;
  const tagsByContact = await loadTagsByContactId(tx, input.clientId, [row.id]);
  return mapContactRow(row, tagsByContact.get(row.id) ?? []);
}
