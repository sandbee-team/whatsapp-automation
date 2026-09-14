import { getTableColumns, getTableName } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { SCHEMA_TABLES } from '../schema/index.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

interface InformationSchemaColumn {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
}

/**
 * Explicit mapping from a Drizzle column's `getSQLType()` output to the
 * Postgres `udt_name` it is expected to resolve to. Base types below are
 * abbreviated by Postgres internally (`integer` -> `int4`, `bigint` ->
 * `int8`, `timestamp with time zone` -> `timestamptz`); anything NOT in this
 * table (citext, every enum name) already returns the exact `udt_name` from
 * `getSQLType()` itself, so the fallback is the identity.
 */
const SQL_TYPE_TO_UDT_NAME: Record<string, string> = {
  uuid: 'uuid',
  text: 'text',
  citext: 'citext',
  integer: 'int4',
  bigint: 'int8',
  smallint: 'int2',
  boolean: 'bool',
  'timestamp with time zone': 'timestamptz',
  timestamp: 'timestamp',
};

function expectedUdtName(sqlType: string): string {
  return SQL_TYPE_TO_UDT_NAME[sqlType] ?? sqlType;
}

/**
 * Blueprint mandatory test - `every_drizzle_declared_column_exists_in_the_
 * database_with_the_same_type`. Walks `SCHEMA_TABLES` (the manifest in
 * `db/schema/index.ts`) and diffs each Drizzle table's declared columns
 * against `information_schema.columns` in BOTH directions: a declared
 * column missing from the DB, a DB column missing from the Drizzle mirror,
 * a type mismatch, or a nullability mismatch all fail by naming
 * `table.column`.
 */
describe('schema_parity', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('every_drizzle_declared_column_exists_in_the_database_with_the_same_type', async () => {
    const pool = await getMigratedPool();
    const failures: string[] = [];

    for (const entry of SCHEMA_TABLES) {
      const tableName = getTableName(entry.table);
      expect(tableName, `manifest entry tableName mismatch for ${entry.tableName}`).toBe(
        entry.tableName,
      );

      const declaredColumns = getTableColumns(entry.table);

      const dbResult = await pool.query<InformationSchemaColumn>(
        `SELECT column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [tableName],
      );

      const dbColumnsByName = new Map(dbResult.rows.map((row) => [row.column_name, row]));
      const declaredDbNames = new Set<string>();

      for (const column of Object.values(declaredColumns)) {
        declaredDbNames.add(column.name);
        const qualifiedName = `${tableName}.${column.name}`;
        const dbColumn = dbColumnsByName.get(column.name);

        if (!dbColumn) {
          failures.push(`${qualifiedName}: declared in Drizzle but missing in the database`);
          continue;
        }

        const wantUdtName = expectedUdtName(column.getSQLType());
        if (dbColumn.udt_name !== wantUdtName) {
          failures.push(
            `${qualifiedName}: type mismatch (drizzle '${column.getSQLType()}' -> expected udt_name ` +
              `'${wantUdtName}', db udt_name '${dbColumn.udt_name}' / data_type '${dbColumn.data_type}')`,
          );
        }

        const dbNotNull = dbColumn.is_nullable === 'NO';
        if (dbNotNull !== column.notNull) {
          failures.push(
            `${qualifiedName}: NOT NULL mismatch (drizzle notNull=${String(column.notNull)}, ` +
              `db is_nullable=${dbColumn.is_nullable})`,
          );
        }
      }

      for (const dbColumn of dbResult.rows) {
        if (!declaredDbNames.has(dbColumn.column_name)) {
          failures.push(
            `${tableName}.${dbColumn.column_name}: exists in the database but is not declared in Drizzle`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
