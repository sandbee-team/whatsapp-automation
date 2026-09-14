import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import { resolveDatabaseUrl } from './db-url.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_MIGRATIONS_DIR = path.resolve(HERE, '..', '..', 'migrations');

/**
 * Shared, memoized-per-process pool against the persistent dev database
 * (`wp`, resolved via `resolveDatabaseUrl`) - NOT a scratch database: the
 * founder demo depends on this database staying populated, and later P02
 * steps' suites reuse the same migrated pool rather than each re-running
 * migrations against their own throwaway database. `runMigrations` is a
 * no-op when the dev DB is already at the current version (see
 * `db/src/migrate.ts`), so calling this repeatedly across test files is
 * cheap and safe.
 */
let pool: pg.Pool | undefined;
let migratedOnce: Promise<void> | undefined;

export async function getMigratedPool(): Promise<pg.Pool> {
  if (!migratedOnce) {
    migratedOnce = runMigrations({
      databaseUrl: resolveDatabaseUrl(),
      migrationsDir: REAL_MIGRATIONS_DIR,
    }).then(() => undefined);
  }
  await migratedOnce;

  if (!pool) {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'wp-db-tests',
    });
  }

  return pool;
}

/** Closes the shared pool - call from `afterAll` so the process can exit. */
export async function closeMigratedPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
  migratedOnce = undefined;
}
