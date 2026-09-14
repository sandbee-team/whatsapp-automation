import pg from 'pg';

/**
 * Minimal query surface handed to a `withTenant` callback - just enough to
 * run parameterized SQL against the transaction that already has
 * `app.client_id` set. Deliberately not `pg.PoolClient` itself, so callers
 * can never reach for `.release()`/`.query('BEGIN')` and break the
 * transaction this module owns.
 */
export interface TenantQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/**
 * Thrown by `withTenant` when `clientId` is not a well-formed UUID -
 * including, especially, the empty string. An empty string would defeat the
 * `nullif(current_setting(...), '')` guard every `tenant_isolation` policy
 * relies on (see migration 0005): `set_config('app.client_id', '', true)`
 * would make `current_setting` return `''`, `nullif('', '')` return NULL,
 * and the policy predicate `client_id = NULL` match zero rows - a silent
 * "no rows" failure instead of a loud one. Rejecting non-UUID input before
 * it ever reaches `set_config` keeps that failure loud.
 */
export class InvalidTenantIdError extends Error {
  constructor(clientId: string) {
    super(`withTenant: '${clientId}' is not a valid UUID client id`);
    this.name = 'InvalidTenantIdError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantDb {
  /**
   * Runs `fn` inside a single transaction scoped to `clientId`:
   * `set_config('app.client_id', clientId, true)` (transaction-local - the
   * only sanctioned way to set it; plain `SET` is banned repo-wide, see
   * `scripts/check-sql-lint.ts`) is applied first, then `fn` runs against a
   * `TenantQueryable` bound to that same client. Commits on success, rolls
   * back and rethrows on any error, and always releases the client back to
   * the pool.
   */
  withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T>;
}

/**
 * Minimal query surface handed to a `withWorker` callback - deliberately a
 * DISTINCT nominal type from `TenantQueryable` (via the `__workerBrand`
 * marker) so a bare `pg.Pool`/`pg.Client`/`TenantQueryable` is never
 * assignable where a `WorkerQueryable` is required by a function's
 * signature (e.g. `lease-state-repo.ts`'s `renewBatch`) - the whole point of
 * this runner is that `app.worker_id` and the statement that depends on it
 * MUST share one pinned connection/transaction, and a type-level distinction
 * is what stops a future caller from quietly passing a bare pool again (the
 * exact bug this runner exists to fix - see C1 finding 2).
 */
export interface WorkerQueryable extends TenantQueryable {
  readonly __workerBrand: unique symbol;
}

export interface WorkerDb {
  /**
   * Runs `fn` inside a single transaction on ONE pinned connection:
   * `set_config('app.worker_id', workerId, true)` (transaction-local) is
   * applied first, then `fn` runs against a `WorkerQueryable` bound to that
   * same connection/transaction. Commits on success, rolls back and
   * rethrows on any error, and always releases the connection back to the
   * pool - same commit/rollback/release discipline as `withTenant`.
   *
   * Exists because `set_config(..., true)` is transaction-local: calling it
   * as a separate pool call (a different connection, or the same connection
   * outside an explicit transaction under autocommit) evaporates before any
   * later statement runs - it must share one transaction with the statement
   * that depends on the GUC (see `lease-state-repo.ts`'s `renewBatch`, C1
   * finding 2).
   */
  withWorker<T>(workerId: string, fn: (tx: WorkerQueryable) => Promise<T>): Promise<T>;
}

/** Creates a `TenantDb` bound to `pool`. */
export function createTenantDb(pool: pg.Pool): TenantDb {
  return {
    async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
      if (!UUID_PATTERN.test(clientId)) {
        throw new InvalidTenantIdError(clientId);
      }

      const client = await pool.connect();
      // Only set when the connection itself is left in a state that is
      // unsafe to reuse - i.e. the ROLLBACK attempt (after an application
      // error) itself failed. A clean ROLLBACK fully undoes the transaction,
      // so the connection is fine to return to the pool: application errors
      // (like routine 23505 unique-violations) must not churn the pool.
      // `finally` uses this to decide whether the connection is safe to
      // return to the pool or must be destroyed instead.
      let releaseError: unknown;
      try {
        await client.query('BEGIN');
        try {
          await client.query('SELECT set_config($1, $2, true)', ['app.client_id', clientId]);
          const result = await fn(client);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          // The ROLLBACK gets its own try/catch so a failure rolling back
          // (e.g. the connection is already broken) can never mask the
          // ORIGINAL error - that original error is always what propagates,
          // even if the rollback itself throws.
          try {
            await client.query('ROLLBACK');
            // ROLLBACK succeeded: the connection is clean again, so clear
            // any release-error and let it go back to the pool for reuse.
            releaseError = undefined;
          } catch (rollbackErr) {
            releaseError = rollbackErr;
          }
          throw err;
        }
      } finally {
        // A connection that failed mid-transaction (or whose ROLLBACK itself
        // errored) must never go back to the pool as if it were clean:
        // `release(err)` destroys it instead of returning it for reuse.
        if (releaseError !== undefined) {
          client.release(releaseError as Error);
        } else {
          client.release();
        }
      }
    },
  };
}

/** Creates a `WorkerDb` bound to `pool`. Mirrors `createTenantDb` exactly, keyed on `app.worker_id` instead of `app.client_id`. */
export function createWorkerDb(pool: pg.Pool): WorkerDb {
  return {
    async withWorker<T>(workerId: string, fn: (tx: WorkerQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      // Same reuse-safety discipline as withTenant: only destroy the
      // connection (rather than returning it to the pool) when the ROLLBACK
      // itself fails after an application error.
      let releaseError: unknown;
      try {
        await client.query('BEGIN');
        try {
          await client.query('SELECT set_config($1, $2, true)', ['app.worker_id', workerId]);
          const result = await fn(client as unknown as WorkerQueryable);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          try {
            await client.query('ROLLBACK');
            releaseError = undefined;
          } catch (rollbackErr) {
            releaseError = rollbackErr;
          }
          throw err;
        }
      } finally {
        if (releaseError !== undefined) {
          client.release(releaseError as Error);
        } else {
          client.release();
        }
      }
    },
  };
}
