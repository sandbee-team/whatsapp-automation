import { PG_ENUMS } from '@wp/domain';
import { afterAll, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

interface EnumRow {
  enum_name: string;
  label: string;
}

/**
 * Blueprint mandatory test 23 - `enum_parity_db_vs_domain`. Compares the
 * Postgres `public` schema's enum types (via `pg_type`/`pg_enum`, ordered by
 * `enumsortorder`) against `@wp/domain`'s `PG_ENUMS` manifest in BOTH
 * directions: a domain enum missing/mismatched in the DB fails, and a DB
 * enum missing from the domain mirror also fails - so neither side can ever
 * silently drift from the other.
 */
describe('enum_parity_db_vs_domain', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('enum_parity_db_vs_domain', async () => {
    const pool = await getMigratedPool();

    const result = await pool.query<EnumRow>(`
      SELECT t.typname AS enum_name, e.enumlabel AS label
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.typname, e.enumsortorder
    `);

    const dbEnums = new Map<string, string[]>();
    for (const row of result.rows) {
      const labels = dbEnums.get(row.enum_name) ?? [];
      labels.push(row.label);
      dbEnums.set(row.enum_name, labels);
    }

    // (a) every PG_ENUMS key exists in the DB with the exact same ordered labels.
    for (const [enumName, expectedLabels] of Object.entries(PG_ENUMS)) {
      const actualLabels = dbEnums.get(enumName);
      expect(actualLabels, `enum '${enumName}' missing from the database`).toBeDefined();
      expect(actualLabels).toEqual([...expectedLabels]);
    }

    // (b) every DB enum in `public` is present in PG_ENUMS.
    for (const enumName of dbEnums.keys()) {
      expect(
        Object.hasOwn(PG_ENUMS, enumName),
        `DB enum '${enumName}' has no PG_ENUMS mirror in @wp/domain`,
      ).toBe(true);
    }
  });
});
