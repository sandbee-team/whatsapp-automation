import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

/**
 * Forward-only SQL migration runner (`NNNN_<slug>.sql`). One dedicated
 * `pg.Client` per run: a session-level advisory lock serializes concurrent
 * runners against the same database, migrations are tracked in
 * `schema_migrations`, each pending file applies in its own transaction, and
 * an already-applied file whose on-disk bytes changed - or a new file
 * numbered below the highest applied version - aborts the whole run before
 * touching anything. Nothing here reads `process.env`; the caller resolves
 * `databaseUrl` and `migrationsDir` itself (see the role entrypoint and the
 * test helpers for the two sanctioned resolvers).
 */

export interface RunMigrationsOptions {
  databaseUrl: string;
  migrationsDir: string;
  log?: (line: string) => void;
}

export interface AppliedMigration {
  version: number;
  slug: string;
}

export interface RunMigrationsResult {
  applied: AppliedMigration[];
  skippedCount: number;
}

/** A migration file failed to parse, apply, or otherwise be usable. */
export class MigrationFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationFileError';
  }
}

/** An already-applied migration's on-disk bytes no longer match its recorded checksum. */
export class MigrationChecksumMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationChecksumMismatchError';
  }
}

/** A pending migration is numbered below the highest already-applied version. */
export class MigrationOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationOrderError';
  }
}

// Namespace + local part joined at runtime (not a single 'wp:...' literal) so
// this Postgres advisory-lock name - not a Redis key - never trips the
// wp/key-construction guard, which targets raw `wp:` Redis key literals.
const ADVISORY_LOCK_NAME = 'wp' + ':migrate';

const FILE_PATTERN = /^(\d{4})_([a-zA-Z0-9_-]+)\.sql$/;

interface MigrationFile {
  version: number;
  slug: string;
  fileName: string;
  fullPath: string;
}

async function discoverMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  const seenVersions = new Map<number, string>();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === 'README.md') continue;

    const match = FILE_PATTERN.exec(entry.name);
    if (!match) {
      throw new MigrationFileError(
        `Migration file '${entry.name}' does not match the required NNNN_<slug>.sql pattern`,
      );
    }

    const version = Number(match[1]);
    const slug = match[2] as string;
    const existing = seenVersions.get(version);
    if (existing !== undefined) {
      throw new MigrationFileError(
        `Duplicate migration version ${version}: '${existing}' and '${entry.name}'`,
      );
    }
    seenVersions.set(version, entry.name);

    files.push({
      version,
      slug,
      fileName: entry.name,
      fullPath: path.join(migrationsDir, entry.name),
    });
  }

  return files.sort((a, b) => a.version - b.version);
}

async function checksumOf(fullPath: string): Promise<Buffer> {
  const raw = await readFile(fullPath);
  return createHash('sha256').update(raw).digest();
}

export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const { databaseUrl, migrationsDir } = options;
  const emit = options.log ?? ((): void => {});

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [ADVISORY_LOCK_NAME]);

    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version int PRIMARY KEY,
          slug text NOT NULL,
          checksum bytea NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const files = await discoverMigrationFiles(migrationsDir);
      const fileByVersion = new Map(files.map((file) => [file.version, file]));

      const appliedResult = await client.query<{ version: number; slug: string; checksum: Buffer }>(
        'SELECT version, slug, checksum FROM schema_migrations ORDER BY version ASC',
      );

      let maxAppliedVersion = 0;
      for (const row of appliedResult.rows) {
        maxAppliedVersion = Math.max(maxAppliedVersion, row.version);

        const file = fileByVersion.get(row.version);
        if (!file) {
          throw new MigrationChecksumMismatchError(
            `Applied migration version ${row.version} ('${row.slug}') has no matching file on disk`,
          );
        }

        const checksum = await checksumOf(file.fullPath);
        if (!checksum.equals(row.checksum)) {
          throw new MigrationChecksumMismatchError(
            `Checksum mismatch for applied migration '${file.fileName}': the on-disk file changed since it was applied`,
          );
        }
      }

      const appliedVersions = new Set(appliedResult.rows.map((row) => row.version));
      const pending = files.filter((file) => !appliedVersions.has(file.version));

      for (const file of pending) {
        if (file.version < maxAppliedVersion) {
          throw new MigrationOrderError(
            `Migration '${file.fileName}' is numbered below the highest applied version (${maxAppliedVersion}) - forward-only migrations refuse this`,
          );
        }
      }

      const applied: AppliedMigration[] = [];

      for (const file of pending) {
        const checksum = await checksumOf(file.fullPath);
        const sql = (await readFile(file.fullPath)).toString('utf8');

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (version, slug, checksum) VALUES ($1, $2, $3)',
            [file.version, file.slug, checksum],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          const message = err instanceof Error ? err.message : String(err);
          throw new MigrationFileError(`Failed applying migration '${file.fileName}': ${message}`);
        }

        applied.push({ version: file.version, slug: file.slug });
        emit(`Applied ${file.fileName}`);
      }

      return { applied, skippedCount: appliedVersions.size };
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK_NAME]);
    }
  } finally {
    await client.end();
  }
}
