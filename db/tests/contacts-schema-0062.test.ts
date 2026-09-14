import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * P20 C1 round-3 fix - schema test for migration 0062 (`contacts.last_import_id`).
 * Split from the sibling `contacts-schema.test.ts` purely for that file's own
 * max-lines cap.
 */
describe('contacts_schema_0062', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('last_import_id_is_nullable_uuid_and_import_id_is_never_overwritten_by_the_upsert', async () => {
    const pool = await getMigratedPool();

    const column = await pool.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'last_import_id'`,
    );
    expect(column.rowCount).toBe(1);
    expect(column.rows[0]?.data_type).toBe('uuid');
    expect(column.rows[0]?.is_nullable).toBe('YES');

    const sqlText = await readFile(
      new URL('../queries/upsert-import-contacts.sql', import.meta.url),
      'utf8',
    );
    const statementStart = sqlText.indexOf('-- name: upsert-import-contacts');
    const doUpdateStart = sqlText.indexOf('DO UPDATE SET', statementStart);
    const returningStart = sqlText.indexOf('RETURNING', doUpdateStart);
    const doUpdateClause = sqlText.slice(doUpdateStart, returningStart);

    expect(doUpdateClause).toContain('last_import_id');
    expect(doUpdateClause).not.toMatch(/\bimport_id\s*=/);
    expect(doUpdateClause).not.toContain('opt_out_state');
    expect(doUpdateClause).not.toContain('opted_out_at');
  });
});
