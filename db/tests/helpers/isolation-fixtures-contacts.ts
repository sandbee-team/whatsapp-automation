import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * P20 (contacts-and-import) Unit U1 seed helper for `isolation-fixtures.ts`'s
 * `seedTenant` - split into a sibling module to stay under the 300-line file
 * cap (same "move a self-contained registry/helper to a sibling module"
 * idiom `send-path-tables.ts`/`canonical-authority-keys.ts` already
 * established). Seeds one row per new table, in order: contacts ->
 * contact_tags -> contact_tag_links -> contact_imports ->
 * contact_import_errors -> consent_records.
 */

export interface SeedContactsTenantInput {
  clientId: string;
  suffix: string;
  name: string;
}

export interface SeedContactsTenantResult {
  contactId: string;
  tagId: string;
  importId: string;
}

export async function seedContactsTenant(
  pool: pg.Pool,
  { clientId, suffix, name }: SeedContactsTenantInput,
): Promise<SeedContactsTenantResult> {
  const contactId = randomUUID();
  const tagId = randomUUID();
  const importId = randomUUID();
  const phoneHash = randomBytes(32);
  const digits = suffix.replace(/\D/g, '').padStart(7, '0').slice(-7);
  const phoneE164 = `+1555${digits}`;
  const waJid = `1555${digits}@s.whatsapp.net`;

  await pool.query(
    `INSERT INTO contacts
        (id, client_id, phone_e164, phone_hash, wa_jid, display_name, source)
      VALUES ($1, $2, $3, $4, $5, $6, 'manual')`,
    [contactId, clientId, phoneE164, phoneHash, waJid, `Isolation Suite A Contact ${name}`],
  );

  await pool.query(
    `INSERT INTO contact_tags (id, client_id, name, color)
      VALUES ($1, $2, $3, $4)`,
    [tagId, clientId, `isolation-suite-a-tag-${suffix}`, '#00ff00'],
  );

  await pool.query(
    `INSERT INTO contact_tag_links (client_id, tag_id, contact_id)
      VALUES ($1, $2, $3)`,
    [clientId, tagId, contactId],
  );

  await pool.query(
    `INSERT INTO contact_imports
        (id, client_id, storage_key, mapping, default_country, attestation_text,
         attested_by_user_id, attested_at)
      VALUES ($1, $2, $3, $4::jsonb, 'IN', $5, $6, now())`,
    [
      importId,
      clientId,
      `clients/${clientId}/imports/isolation-suite-a-${suffix}.csv`,
      JSON.stringify({ phone: 'col A' }),
      'isolation suite A probe attestation',
      randomUUID(),
    ],
  );

  await pool.query(
    `INSERT INTO contact_import_errors (import_id, client_id, row_no, reason)
      VALUES ($1, $2, 1, 'isolation-suite-a-probe')`,
    [importId, clientId],
  );

  await pool.query(
    `INSERT INTO consent_records (client_id, basis, source_note)
      VALUES ($1, 'imported_with_attestation', 'isolation suite A probe')`,
    [clientId],
  );

  return { contactId, tagId, importId };
}
