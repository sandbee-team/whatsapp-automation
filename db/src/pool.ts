import pg from 'pg';

/**
 * `createPool` options. Connection info is always passed in explicitly -
 * nothing in `db/src/**` reads `process.env` directly; callers (role
 * entrypoints, tests) resolve the connection string themselves.
 *
 * `statementTimeoutMs`/`idleInTransactionSessionTimeoutMs` are wired via
 * Postgres's connection `options` startup parameter (`-c statement_timeout=…
 * -c idle_in_transaction_session_timeout=…`) so every session on the pool is
 * bounded server-side, independent of any application-level timeout.
 * `connectionTimeoutMillis` is passed straight through to `pg.Pool` (its own
 * native option) as the max time to wait for a new connection to establish.
 */
export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
  connectionTimeoutMillis?: number;
  statementTimeoutMs?: number;
  idleInTransactionSessionTimeoutMs?: number;
}

/** Creates a `pg.Pool` from explicitly-provided connection info. */
export function createPool(options: CreatePoolOptions): pg.Pool {
  const sessionOptions = buildSessionOptions(options);

  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    ...(sessionOptions ? { options: sessionOptions } : {}),
  });
}

/**
 * Builds the `-c key=value` startup `options` string for the timeouts that
 * have no dedicated `pg.Pool` field. Returns `undefined` when neither timeout
 * is set, so callers that don't opt in get pg's normal (unbounded) defaults.
 */
function buildSessionOptions(options: CreatePoolOptions): string | undefined {
  const parts: string[] = [];
  if (options.statementTimeoutMs !== undefined) {
    parts.push(`-c statement_timeout=${options.statementTimeoutMs}`);
  }
  if (options.idleInTransactionSessionTimeoutMs !== undefined) {
    parts.push(
      `-c idle_in_transaction_session_timeout=${options.idleInTransactionSessionTimeoutMs}`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}
