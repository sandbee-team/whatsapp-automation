import { randomBytes } from 'node:crypto';
import pg from 'pg';

export interface ScratchDb {
  url: string;
  drop: () => Promise<void>;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function withDatabaseName(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/**
 * Creates a throwaway `wp_scratch_<8 hex>` database via the given admin
 * connection URL, so migration-runner tests can migrate an empty database
 * repeatedly instead of sharing (and fighting over) the dev `wp` database.
 */
export async function createScratchDb(adminUrl: string): Promise<ScratchDb> {
  const name = `wp_scratch_${randomBytes(4).toString('hex')}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
  } finally {
    await admin.end();
  }

  const drop = async (): Promise<void> => {
    const dropAdmin = new pg.Client({ connectionString: adminUrl });
    await dropAdmin.connect();
    try {
      await dropAdmin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [name],
      );
      await dropAdmin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
    } finally {
      await dropAdmin.end();
    }
  };

  return { url: withDatabaseName(adminUrl, name), drop };
}
