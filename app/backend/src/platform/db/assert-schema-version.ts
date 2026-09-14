import { EXPECTED_SCHEMA_VERSION } from '@wp/db';

/**
 * Structurally compatible with `pg.Pool` / `pg.Client` (and any stub used in
 * tests) without importing `pg` into this module.
 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Thrown when the database's applied migration version does not match this
 * build's compiled `EXPECTED_SCHEMA_VERSION` - whether the database is
 * behind (a migration was not run) or ahead (this build is stale). Also
 * thrown, fail-closed, when the version cannot be determined at all (the
 * `schema_migrations` table is missing, the query errors, the connection is
 * down, ...).
 */
export class SchemaVersionMismatchError extends Error {
  code = 'SCHEMA_VERSION_MISMATCH';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SchemaVersionMismatchError';
  }
}

interface MaxVersionRow {
  max_version: number | string | null;
}

/**
 * Asserts the database's applied schema version matches
 * `EXPECTED_SCHEMA_VERSION`. Fail-closed: any error reading the version
 * (missing table, connection failure, anything) is wrapped and re-thrown as
 * `SchemaVersionMismatchError` rather than allowed to pass silently.
 */
export async function assertSchemaVersion(db: Queryable): Promise<void> {
  let actual: number;

  try {
    const result = await db.query('SELECT max(version) AS max_version FROM schema_migrations');
    const row = result.rows[0] as MaxVersionRow | undefined;
    const rawMaxVersion = row?.max_version ?? null;
    actual = rawMaxVersion === null ? 0 : Number(rawMaxVersion);
  } catch (err) {
    throw new SchemaVersionMismatchError(
      `Failed to read the applied schema version: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (actual !== EXPECTED_SCHEMA_VERSION) {
    throw new SchemaVersionMismatchError(
      `Schema version mismatch: expected ${EXPECTED_SCHEMA_VERSION}, database reports ${actual}`,
    );
  }
}
