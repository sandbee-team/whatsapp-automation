import { appendFile, cp, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  MigrationChecksumMismatchError,
  MigrationFileError,
  MigrationOrderError,
  runMigrations,
} from '../src/migrate.js';
import { EXPECTED_SCHEMA_VERSION } from '../src/schema-version.js';
import { resolveDatabaseUrl } from './helpers/db-url.js';
import { createScratchDb, type ScratchDb } from './helpers/scratch-db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_MIGRATIONS_DIR = path.resolve(HERE, '..', 'migrations');
const FIXTURES_DIR = path.join(HERE, 'fixtures', 'migrations-basic');
const MID_FILE_FAILURE_FIXTURES_DIR = path.join(HERE, 'fixtures', 'migrate-mid-file-failure');

async function withScratchDb<T>(fn: (scratch: ScratchDb) => Promise<T>): Promise<T> {
  const scratch = await createScratchDb(resolveDatabaseUrl());
  try {
    return await fn(scratch);
  } finally {
    await scratch.drop();
  }
}

async function copyFixturesToTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wp-migrate-'));
  await cp(FIXTURES_DIR, dir, { recursive: true });
  return dir;
}

async function copyDirToTempDir(sourceDir: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wp-migrate-'));
  await cp(sourceDir, dir, { recursive: true });
  return dir;
}

async function tableExists(url: string, tableName: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = $2) AS exists',
      ['public', tableName],
    );
    return result.rows[0]?.exists ?? false;
  } finally {
    await client.end();
  }
}

async function schemaMigrationVersions(url: string): Promise<number[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version ASC',
    );
    return result.rows.map((row) => row.version);
  } finally {
    await client.end();
  }
}

describe('migration runner', () => {
  it('migrations_apply_in_order_and_are_recorded_with_a_checksum', async () => {
    await withScratchDb(async (scratch) => {
      const onDiskFiles = (await readdir(REAL_MIGRATIONS_DIR)).filter((name) =>
        name.endsWith('.sql'),
      );

      const result = await runMigrations({
        databaseUrl: scratch.url,
        migrationsDir: REAL_MIGRATIONS_DIR,
      });

      expect(result.applied.length).toBe(onDiskFiles.length);

      // Structural, not a second pinned literal (P03 close, finding 1): a
      // previous version of this test pinned `onDiskFiles.length` to a bare
      // number that itself drifted out of sync with
      // `EXPECTED_SCHEMA_VERSION` (schema-version.ts) - a stale reviewer
      // pin next to a stale compiled constant, catching nothing. Instead,
      // assert `EXPECTED_SCHEMA_VERSION` equals BOTH the on-disk migration
      // file count AND the highest on-disk version number, so adding a
      // migration file without bumping the constant (or vice versa) fails
      // here, not just at boot via `assertSchemaVersion`.
      const onDiskVersions = onDiskFiles.map((name) => Number(name.slice(0, 4)));
      expect(EXPECTED_SCHEMA_VERSION).toBe(onDiskFiles.length);
      expect(EXPECTED_SCHEMA_VERSION).toBe(Math.max(...onDiskVersions));

      const versions = result.applied.map((migration) => migration.version);
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
      expect(new Set(versions).size).toBe(versions.length);

      const client = new pg.Client({ connectionString: scratch.url });
      await client.connect();
      try {
        const rows = (
          await client.query<{ version: number; checksum: Buffer }>(
            'SELECT version, checksum FROM schema_migrations ORDER BY version ASC',
          )
        ).rows;
        expect(rows.length).toBe(onDiskFiles.length);
        for (const row of rows) {
          expect(row.checksum).not.toBeNull();
        }
      } finally {
        await client.end();
      }
    });
  });

  it('re_running_the_runner_on_a_migrated_database_is_a_no_op', async () => {
    await withScratchDb(async (scratch) => {
      const dir = await copyFixturesToTempDir();

      const first = await runMigrations({ databaseUrl: scratch.url, migrationsDir: dir });
      expect(first.applied.length).toBe(2);

      const second = await runMigrations({ databaseUrl: scratch.url, migrationsDir: dir });
      expect(second.applied.length).toBe(0);
      expect(second.skippedCount).toBe(2);
    });
  });

  it('an_edited_applied_migration_fails_the_runner', async () => {
    await withScratchDb(async (scratch) => {
      const dir = await copyFixturesToTempDir();

      await runMigrations({ databaseUrl: scratch.url, migrationsDir: dir });

      await appendFile(path.join(dir, '0001_widgets.sql'), '\n-- edited after being applied\n');
      await writeFile(
        path.join(dir, '0003_widgets-cousin.sql'),
        'CREATE TABLE widgets_cousin (\n  id serial PRIMARY KEY,\n  name text NOT NULL\n);\n',
      );

      await expect(runMigrations({ databaseUrl: scratch.url, migrationsDir: dir })).rejects.toThrow(
        MigrationChecksumMismatchError,
      );

      expect(await schemaMigrationVersions(scratch.url)).toEqual([1, 2]);
    });
  });

  it('two_concurrent_runners_apply_every_migration_exactly_once', async () => {
    await withScratchDb(async (scratch) => {
      const dir = await copyFixturesToTempDir();

      const [a, b] = await Promise.all([
        runMigrations({ databaseUrl: scratch.url, migrationsDir: dir }),
        runMigrations({ databaseUrl: scratch.url, migrationsDir: dir }),
      ]);

      expect(a.applied.length + b.applied.length).toBe(2);
      expect(await schemaMigrationVersions(scratch.url)).toEqual([1, 2]);
    });
  });

  it('a_new_file_numbered_below_an_applied_version_is_refused', async () => {
    await withScratchDb(async (scratch) => {
      const gadgetsOnlyDir = await mkdtemp(path.join(tmpdir(), 'wp-migrate-'));
      await cp(
        path.join(FIXTURES_DIR, '0002_gadgets.sql'),
        path.join(gadgetsOnlyDir, '0002_gadgets.sql'),
      );

      const first = await runMigrations({
        databaseUrl: scratch.url,
        migrationsDir: gadgetsOnlyDir,
      });
      expect(first.applied.map((migration) => migration.version)).toEqual([2]);

      const fullDir = await copyFixturesToTempDir();

      await expect(
        runMigrations({ databaseUrl: scratch.url, migrationsDir: fullDir }),
      ).rejects.toThrow(MigrationOrderError);

      expect(await schemaMigrationVersions(scratch.url)).toEqual([2]);
    });
  });

  it('a_migration_that_fails_mid_file_leaves_no_partial_state_and_is_reapplied_after_fix', async () => {
    await withScratchDb(async (scratch) => {
      const dir = await copyDirToTempDir(MID_FILE_FAILURE_FIXTURES_DIR);

      // 0002's CREATE TABLE succeeds, then the NOT NULL insert fails: the
      // whole file runs in one transaction (see db/src/migrate.ts), so the
      // failure must abort BOTH statements, not just the second one.
      await expect(runMigrations({ databaseUrl: scratch.url, migrationsDir: dir })).rejects.toThrow(
        MigrationFileError,
      );

      expect(await schemaMigrationVersions(scratch.url)).toEqual([1]);
      expect(await tableExists(scratch.url, 'mid_file_widgets')).toBe(false);

      // Fix the file (the earlier failing INSERT removed) and rerun: the
      // runner must recover cleanly, applying version 2 as if the failed
      // attempt never happened.
      await writeFile(
        path.join(dir, '0002_mid_file_bad.sql'),
        'CREATE TABLE mid_file_widgets (\n  id serial PRIMARY KEY,\n  name text NOT NULL\n);\n',
      );

      const second = await runMigrations({ databaseUrl: scratch.url, migrationsDir: dir });
      expect(second.applied.map((migration) => migration.version)).toEqual([2]);
      expect(await schemaMigrationVersions(scratch.url)).toEqual([1, 2]);
      expect(await tableExists(scratch.url, 'mid_file_widgets')).toBe(true);
    });
  });
});
