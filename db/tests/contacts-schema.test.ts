import { randomBytes, randomUUID } from 'node:crypto';
import { PG_ENUMS } from '@wp/domain';
import { afterAll, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * P20 Unit U1 - schema tests for migrations 0060/0061 (contacts/tags/imports
 * and the composite tenant FKs). Pure catalog/information_schema and
 * boundary-constraint probes - no business-logic writes.
 */
describe('contacts_schema', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('contacts_unique_index_is_partial_on_deleted_at', async () => {
    const pool = await getMigratedPool();

    const indexDef = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'contacts_client_phone_uq'`,
    );
    expect(indexDef.rowCount).toBe(1);
    expect(indexDef.rows[0]?.indexdef).toContain('WHERE (deleted_at IS NULL)');

    const client = await pool.connect();
    let clientId: string | undefined;
    try {
      clientId = await insertProbeClient(client, 'partial-unique');
      const phoneE164 = `+15550${Date.now().toString().slice(-6)}`;

      const insertSql = `INSERT INTO contacts (client_id, phone_e164, phone_hash, wa_jid, source)
        VALUES ($1, $2, $3, $4, 'manual') RETURNING id`;
      const first = await client.query<{ id: string }>(insertSql, [
        clientId,
        phoneE164,
        randomBytes(32),
        `${phoneE164.replace('+', '')}@s.whatsapp.net`,
      ]);

      await expect(
        client.query(insertSql, [
          clientId,
          phoneE164,
          randomBytes(32),
          `${phoneE164.replace('+', '')}@s.whatsapp.net`,
        ]),
      ).rejects.toMatchObject({ code: '23505' });

      await client.query('UPDATE contacts SET deleted_at = now() WHERE id = $1', [
        first.rows[0]?.id,
      ]);

      await expect(
        client.query(insertSql, [
          clientId,
          phoneE164,
          randomBytes(32),
          `${phoneE164.replace('+', '')}@s.whatsapp.net`,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await cleanupProbeClient(client, clientId);
      client.release();
    }
  });

  it('every_contacts_table_leads_with_client_id_and_is_not_partitioned', async () => {
    const pool = await getMigratedPool();
    const tables = [
      'contacts',
      'contact_tags',
      'contact_tag_links',
      'contact_imports',
      'contact_import_errors',
      'consent_records',
    ];

    const surrogatePkTables = ['contacts', 'contact_tags', 'contact_imports', 'consent_records'];
    for (const tableName of surrogatePkTables) {
      const columns = await pool.query<{ attname: string }>(
        `SELECT a.attname
           FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
          WHERE c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum
          LIMIT 2`,
        [tableName],
      );
      expect(
        columns.rows.map((r) => r.attname),
        tableName,
      ).toEqual(['id', 'client_id']);
    }

    for (const tableName of ['contact_tag_links', 'contact_import_errors']) {
      const clientIdCol = await pool.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'client_id'`,
        [tableName],
      );
      expect(clientIdCol.rowCount, tableName).toBe(1);
      expect(clientIdCol.rows[0]?.is_nullable, tableName).toBe('NO');
    }

    const relRows = await pool.query<{
      relname: string;
      relkind: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relkind, relrowsecurity, relforcerowsecurity
         FROM pg_catalog.pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
      [tables],
    );
    expect(relRows.rowCount).toBe(tables.length);
    for (const row of relRows.rows) {
      expect(row.relkind, row.relname).toBe('r');
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }

    const notNullRows = await pool.query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1) AND column_name = 'client_id'`,
      [tables],
    );
    expect(notNullRows.rowCount).toBe(tables.length);
    for (const row of notNullRows.rows) {
      expect(row.is_nullable, row.table_name).toBe('NO');
    }
  });

  it('attrs_over_two_kilobytes_is_rejected_by_the_check_constraint', async () => {
    const pool = await getMigratedPool();
    const client = await pool.connect();
    let clientId: string | undefined;
    try {
      clientId = await insertProbeClient(client, 'attrs-check');
      const insertSql = `INSERT INTO contacts (client_id, phone_e164, phone_hash, wa_jid, source, attrs)
        VALUES ($1, $2, $3, $4, 'manual', $5::jsonb)`;

      const bigAttrs = jsonObjectOfByteLength(2100);
      const okAttrs = jsonObjectOfByteLength(2000);

      await expect(
        client.query(insertSql, [
          clientId,
          `+15551${Date.now().toString().slice(-6)}`,
          randomBytes(32),
          `probe-big-${Date.now()}@s.whatsapp.net`,
          bigAttrs,
        ]),
      ).rejects.toMatchObject({ code: '23514' });

      await expect(
        client.query(insertSql, [
          clientId,
          `+15552${Date.now().toString().slice(-6)}`,
          randomBytes(32),
          `probe-ok-${Date.now()}@s.whatsapp.net`,
          okAttrs,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await cleanupProbeClient(client, clientId);
      client.release();
    }
  });

  it('a_tag_link_cannot_reference_another_tenants_tag_or_contact', async () => {
    const pool = await getMigratedPool();
    const client = await pool.connect();
    let clientA: string | undefined, clientB: string | undefined;
    try {
      clientA = await insertProbeClient(client, 'ctl-tenant-a');
      clientB = await insertProbeClient(client, 'ctl-tenant-b');
      const contactAId = await insertProbeContact(client, clientA);
      const tagAId = await insertProbeTag(client, clientA);
      const contactBId = await insertProbeContact(client, clientB);
      const tagBId = await insertProbeTag(client, clientB);
      const insertLinkSql = `INSERT INTO contact_tag_links (client_id, tag_id, contact_id)
        VALUES ($1, $2, $3)`;
      // Cross-tenant tag or contact -> rejected at the storage layer (23503); same-tenant -> succeeds.
      await expect(
        client.query(insertLinkSql, [clientA, tagBId, contactAId]),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        client.query(insertLinkSql, [clientA, tagAId, contactBId]),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        client.query(insertLinkSql, [clientA, tagAId, contactAId]),
      ).resolves.toMatchObject({ rowCount: 1 });
      // ON DELETE CASCADE preserved: deleting the tag cascades the link away.
      await client.query('DELETE FROM contact_tags WHERE id = $1', [tagAId]);
      const remaining = await client.query(
        'SELECT 1 FROM contact_tag_links WHERE client_id = $1 AND tag_id = $2',
        [clientA, tagAId],
      );
      expect(remaining.rowCount).toBe(0);
    } finally {
      await cleanupProbeClient(client, clientA);
      await cleanupProbeClient(client, clientB);
      client.release();
    }
  });

  it('enum_parity_db_vs_domain_for_the_three_new_enums', async () => {
    const pool = await getMigratedPool();
    const enumNames = [
      'contact_source',
      'contact_opt_out_state',
      'contact_import_status',
      'consent_basis',
    ];

    const result = await pool.query<{ enum_name: string; label: string }>(
      `SELECT t.typname AS enum_name, e.enumlabel AS label
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = ANY($1)
        ORDER BY t.typname, e.enumsortorder`,
      [enumNames],
    );

    const dbEnums = new Map<string, string[]>();
    for (const row of result.rows) {
      const labels = dbEnums.get(row.enum_name) ?? [];
      labels.push(row.label);
      dbEnums.set(row.enum_name, labels);
    }

    for (const enumName of enumNames) {
      expect(dbEnums.get(enumName), enumName).toEqual([
        ...PG_ENUMS[enumName as keyof typeof PG_ENUMS],
      ]);
    }
  });
});

/** JSON-encodes a single-key object whose serialized text is exactly `totalBytes` long. */
function jsonObjectOfByteLength(totalBytes: number): string {
  const prefix = '{"a":"';
  const suffix = '"}';
  const padLength = totalBytes - prefix.length - suffix.length;
  return `${prefix}${'a'.repeat(Math.max(padLength, 0))}${suffix}`;
}

/** Inserts a minimal probe client (bypassing RLS as the pool's migrator/superuser role) and returns its id. */
async function insertProbeClient(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  label: string,
): Promise<string> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const id = randomUUID();
  await client.query(`INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)`, [
    id,
    `Contacts Schema Probe ${suffix}`,
    `contacts-schema-probe-${suffix}`,
  ]);
  return id;
}

/** Reverse-FK-order cleanup for a probe client created by insertProbeClient; tolerant of undefined (no-op). */
async function cleanupProbeClient(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  clientId: string | undefined,
): Promise<void> {
  if (!clientId) return;
  await client.query('DELETE FROM contact_tag_links WHERE client_id = $1', [clientId]);
  await client.query('DELETE FROM contact_tags WHERE client_id = $1', [clientId]);
  await client.query('DELETE FROM contacts WHERE client_id = $1', [clientId]);
  await client.query('DELETE FROM clients WHERE id = $1', [clientId]);
}

type ProbeQueryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: { id: string }[] }>;
};

/** Inserts a minimal probe contact or tag for the given tenant and returns its id. */
async function insertProbeContact(client: ProbeQueryable, clientId: string): Promise<string> {
  const phoneE164 = `+15559${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10)}`;
  const result = await client.query(
    `INSERT INTO contacts (client_id, phone_e164, phone_hash, wa_jid, source)
     VALUES ($1, $2, $3, $4, 'manual') RETURNING id`,
    [clientId, phoneE164, randomBytes(32), `${phoneE164.replace('+', '')}@s.whatsapp.net`],
  );
  return result.rows[0].id;
}

async function insertProbeTag(client: ProbeQueryable, clientId: string): Promise<string> {
  const name = `probe-tag-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const result = await client.query(
    `INSERT INTO contact_tags (client_id, name) VALUES ($1, $2) RETURNING id`,
    [clientId, name],
  );
  return result.rows[0].id;
}
