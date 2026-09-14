import type { createPool } from '@wp/db';

/**
 * wp-app-role-test-support.ts (P04b Unit UB1b) - the SAME `wrapAsRole`
 * helper as modules/identity/__tests__/wp-app-role-test-support.ts, an
 * intentional per-module DUPLICATE rather than a cross-module import:
 * dependency-cruiser's `no-deep-module-import` rule forbids
 * `modules/tenancy/__tests__/**` from reaching into
 * `modules/identity/__tests__/**` directly (only a module's own `index.ts`
 * may be imported across module boundaries), and this helper is test-only
 * support code, not a module's public surface a real index.ts should carry.
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
