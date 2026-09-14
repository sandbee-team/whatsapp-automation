import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');
const DEV_ENV_PATH = path.join(REPO_ROOT, '.secrets', 'dev.env');

/**
 * Resolves the `DATABASE_URL` app-backend integration tests connect with -
 * mirrors `db/tests/helpers/db-url.ts` exactly (a real `DATABASE_URL` env
 * var wins if set, else this parses `.secrets/dev.env`). Lives under `src/`
 * (not a separate `tests/` tree) because `tsconfig.json`'s `rootDir` is
 * `src` - a test-only helper outside it fails `tsc -b` with TS6059/TS6307.
 * It is never imported by production code (only by
 * `modules/queue/claim.integration.test.ts` today); test helpers are
 * allowed to read `process.env`/dotenv files directly - only shipped
 * runtime code may not.
 */
export function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) {
    return fromEnv;
  }

  let raw: string;
  try {
    raw = readFileSync(DEV_ENV_PATH, 'utf8');
  } catch {
    throw new Error(
      `No DATABASE_URL available: set the DATABASE_URL env var, or ensure it exists at ${DEV_ENV_PATH}.`,
    );
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (key === 'DATABASE_URL') {
      return trimmed.slice(eq + 1).trim();
    }
  }

  throw new Error(
    `No DATABASE_URL available: set the DATABASE_URL env var, or add a DATABASE_URL=... line to ${DEV_ENV_PATH}.`,
  );
}

/** Reads a single `KEY=value` line out of `.secrets/dev.env` - mirrors `platform/redis.ts#readDevEnvPort`. Returns `undefined` (never throws) when the file or line is absent. */
function readDevEnvValue(key: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(DEV_ENV_PATH, 'utf8');
  } catch {
    return undefined;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    if (trimmed.slice(0, eq).trim() === key) {
      return trimmed.slice(eq + 1).trim();
    }
  }

  return undefined;
}

/**
 * The single database name PgBouncer is wired to serve on this box
 * (`infra/compose/docker-compose.dev.yml`'s `pgbouncer` service:
 * `DB_NAME: ${POSTGRES_DB:-wp}`, and its static-config sibling
 * `[databases] wp = host=postgres port=5432` for any box provisioned from
 * the generated `pgbouncer.ini`) - PgBouncer has no wildcard database entry,
 * so a connection naming any OTHER database is refused with PgBouncer's own
 * `no such database: <name>` error. `POSTGRES_DB` overrides it, matching the
 * compose file's own default substitution, so a box provisioned under a
 * different name still resolves correctly.
 */
function pgBouncerDatabaseName(): string {
  return process.env.POSTGRES_DB ?? 'wp';
}

/**
 * Resolves the `DATABASE_URL` a caller should use to connect THROUGH
 * PgBouncer (P26 U2a, `docker-compose.dev.yml`'s `pgbouncer` service) -
 * test/measurement-only, same convention as `resolveDatabaseUrl` above.
 * Resolution order: `PGBOUNCER_URL` env var wins outright (an explicit
 * override is trusted as-is); else read `PGBOUNCER_PORT` out of
 * `.secrets/dev.env`, confirm `resolveDatabaseUrl()`'s own resolved database
 * NAME is the one PgBouncer actually serves (`pgBouncerDatabaseName()`), and
 * only then substitute the port (same host/user/password/db, only the port
 * changes); else `null`.
 *
 * The name check is load-bearing, not cosmetic: a caller that points
 * `DATABASE_URL` at a DIFFERENT database (e.g. `wp_test2`, an isolated test
 * DB) must NOT be silently rerouted through PgBouncer to the fixed `wp`
 * entry PgBouncer's static config maps that port to - PgBouncer has no
 * wildcard database and rejects the mismatch with `no such database:
 * <name>`, which every real WORKER CHILD process swallowed as "mintFence
 * threw, unclear state" and treated as a routine failed acquire (fail-safe
 * by design - core invariant 2), silently leaving every seeded instance
 * owned by its seed placeholder forever (2026-09-11 root cause of the six
 * fleet-scale suites being red against `wp_test2` on every gate since
 * 2026-09-07: the four prior sessions blamed a live measurement fleet
 * instead). Returns `null` rather than throwing when PgBouncer is not
 * configured/reachable/a name match - a caller (the scale-fleet harness)
 * falls back to labeling its measurement `DIRECT-CONNECTION` in that case
 * rather than faking a pooled result (see this phase's own "if PgBouncer
 * will not come up" note).
 */
export function resolvePgBouncerDatabaseUrl(): string | null {
  const fromEnv = process.env.PGBOUNCER_URL;
  if (fromEnv) {
    return fromEnv;
  }

  const port = readDevEnvValue('PGBOUNCER_PORT');
  if (!port) {
    return null;
  }

  let baseUrl: string;
  try {
    baseUrl = resolveDatabaseUrl();
  } catch {
    return null;
  }

  try {
    const url = new URL(baseUrl);
    const databaseName = url.pathname.replace(/^\//, '');
    if (databaseName !== pgBouncerDatabaseName()) {
      return null;
    }
    url.port = port;
    return url.toString();
  } catch {
    return null;
  }
}
