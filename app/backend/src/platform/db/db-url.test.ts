import { afterEach, describe, expect, it } from 'vitest';
import { resolvePgBouncerDatabaseUrl } from './db-url.js';

/**
 * db-url.test.ts - `resolvePgBouncerDatabaseUrl`'s database-name guard
 * (2026-09-11 fix). PgBouncer's `[databases]` mapping is STATIC and has no
 * wildcard entry (`infra/compose/docker-compose.dev.yml`'s `DB_NAME:
 * ${POSTGRES_DB:-wp}`) - a `DATABASE_URL` naming any other database must
 * fall back to `null` (direct-connection), never be silently rerouted
 * through PgBouncer's fixed `wp` entry (root cause of the six fleet-scale
 * suites being red against `wp_test2`, see db-url.ts's own doc comment).
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('resolvePgBouncerDatabaseUrl', () => {
  it('returns null when DATABASE_URL names a database PgBouncer does not serve', () => {
    process.env.DATABASE_URL = 'postgres://wp:secret@127.0.0.1:55432/wp_test2';
    process.env.PGBOUNCER_PORT = '56432';
    delete process.env.PGBOUNCER_URL;
    delete process.env.POSTGRES_DB;

    expect(resolvePgBouncerDatabaseUrl()).toBeNull();
  });

  it('substitutes only the port when DATABASE_URL names the database PgBouncer serves', () => {
    process.env.DATABASE_URL = 'postgres://wp:secret@127.0.0.1:55432/wp';
    process.env.PGBOUNCER_PORT = '56432';
    delete process.env.PGBOUNCER_URL;
    delete process.env.POSTGRES_DB;

    const resolved = resolvePgBouncerDatabaseUrl();
    expect(resolved).not.toBeNull();
    const url = new URL(resolved!);
    expect(url.port).toBe('56432');
    expect(url.pathname).toBe('/wp');
  });

  it('honors POSTGRES_DB as the served database name, not the literal "wp"', () => {
    process.env.DATABASE_URL = 'postgres://wp:secret@127.0.0.1:55432/wp_alt';
    process.env.PGBOUNCER_PORT = '56432';
    process.env.POSTGRES_DB = 'wp_alt';
    delete process.env.PGBOUNCER_URL;

    const resolved = resolvePgBouncerDatabaseUrl();
    expect(resolved).not.toBeNull();
    const url = new URL(resolved!);
    expect(url.port).toBe('56432');
  });

  it('an explicit PGBOUNCER_URL override always wins, regardless of database name', () => {
    process.env.DATABASE_URL = 'postgres://wp:secret@127.0.0.1:55432/wp_test2';
    process.env.PGBOUNCER_URL = 'postgres://wp:secret@127.0.0.1:56432/wp_test2';

    expect(resolvePgBouncerDatabaseUrl()).toBe('postgres://wp:secret@127.0.0.1:56432/wp_test2');
  });
});
