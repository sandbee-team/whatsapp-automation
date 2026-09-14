import type { createPool, TenantDb, TenantQueryable } from '@wp/db';

/**
 * platform/db/test-support/wp-app-role.ts (P05 Unit U3b) - the shared
 * successor to `modules/identity/__tests__/wp-app-role-test-support.ts` and
 * `modules/tenancy/__tests__/wp-app-role-test-support.ts`: `platform/**` is
 * importable by every module (no-deep-module-import only forbids reaching
 * into ANOTHER module's internals, not platform/), so a wp_app-role proof
 * test anywhere in app-backend can import this one copy instead of adding a
 * third module-local duplicate. The two existing module-local copies are
 * left untouched (out of this unit's file scope, and no behavior reason to
 * touch them) - this file is for NEW wp_app-role proof tests (starting with
 * modules/realtime/__tests__/authz-under-wp-app-role.integration.test.ts).
 *
 * Runs a transaction AS a NOLOGIN role (`wp_app`) via `SET LOCAL ROLE` right
 * after `BEGIN`/`BEGIN READ ONLY` (transaction-scoped, reverts automatically
 * at COMMIT/ROLLBACK). NOT itself a test file (no `.test.ts` suffix -
 * vitest's `include` glob never picks it up).
 */

export interface WrappedClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  release(err?: unknown): void;
}

export function wrapAsRole(
  realPool: ReturnType<typeof createPool>,
  role: string,
): { connect(): Promise<WrappedClient> } {
  return {
    async connect(): Promise<WrappedClient> {
      const client = await realPool.connect();
      return {
        async query<T extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ): Promise<{ rows: T[]; rowCount: number | null }> {
          const result = await client.query<T>(sql, params as unknown[] | undefined);
          if (/^BEGIN\b/.test(sql.trim().toUpperCase())) {
            await client.query(`SET LOCAL ROLE ${role}`);
          }
          return { rows: result.rows, rowCount: result.rowCount };
        },
        release(err?: unknown) {
          client.release(err as Error | undefined);
        },
      };
    },
  };
}

/**
 * `TenantDb` (P08 FIX ROUND 2 FIX 1's own test-support need) as a NOLOGIN
 * role, mirroring `engine/lease/test-support/worker-as-role.ts`'s
 * `createWorkerDbAsRole` exactly (role first via `SET LOCAL ROLE`, then the
 * `app.client_id` GUC, both on the SAME pinned connection/transaction, same
 * commit/rollback/release discipline as production's own `createTenantDb`) -
 * a drop-in replacement for `CreateSessionWorkerDeps.tenantDb` in a test that
 * needs `sweepTeardowns`'s `tenantDb.withTenant` calls to run under the REAL
 * `wp_app` role rather than the dev/test pool's own BYPASSRLS role.
 */
export function createTenantDbAsRole(pool: ReturnType<typeof createPool>, role: string): TenantDb {
  return {
    async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let releaseError: unknown;
      try {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL ROLE ${role}`);
          await client.query('SELECT set_config($1, $2, true)', ['app.client_id', clientId]);
          const result = await fn(client as unknown as TenantQueryable);
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
