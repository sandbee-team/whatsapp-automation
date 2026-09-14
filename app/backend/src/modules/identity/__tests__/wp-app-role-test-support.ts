import type { createPool } from '@wp/db';
import { enrolConfirm, type EnrolConfirmResult, type TotpCtx } from '../totp.service.js';

/**
 * wp-app-role-test-support.ts (P04b Unit UB1a, split out of
 * identity-under-wp-app-role.integration.test.ts for max-lines) - the
 * `wrapAsRole` helper that runs a transaction AS a NOLOGIN role (`wp_app`)
 * via `SET LOCAL ROLE` right after `BEGIN`/`BEGIN READ ONLY` (transaction-
 * scoped, reverts automatically at COMMIT/ROLLBACK - migration 0005's own
 * precedent for exercising a NOLOGIN role in tests). NOT itself a test file
 * (no `.test.ts` suffix - vitest's `include` glob never picks it up). Pure
 * code motion: identical behavior to the original inline helper.
 *
 * P04b Unit UB1c adds `runEnrolConfirmAsWpApp` below (moved out of the test
 * file itself to stay under the repo's max-lines cap after this unit's
 * addition) - the wp_app-scoped proof for `enrolConfirm`'s delete-then-insert
 * transaction, now that migration 0016 grants wp_app DELETE on
 * `mfa_recovery_codes`.
 */

export interface WrappedClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  release(err?: unknown): void;
}

/**
 * Wraps the real pool so every transaction driven through it runs AS
 * `role`. Matches BOTH `BEGIN` and `BEGIN READ ONLY` (P04b Unit UB1a,
 * task 4's `getMeForUser` self-scoping transaction) - a plain equality
 * check against `'BEGIN'` alone would silently skip `SET LOCAL ROLE` for a
 * read-only transaction and let it run as the superuser (bypassing RLS
 * entirely) while still looking green.
 */
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
 * Runs `enrolConfirm` fully AS `wp_app`: `enrolConfirm` reads `ctx.db` (a
 * plain `getUserTotpState` SELECT, outside its own transaction) and then
 * opens its OWN transaction - its own `BEGIN`/`COMMIT`/`release()` - via a
 * fresh `ctx.pool.connect()`. Both must run AS wp_app for this to be a real
 * proof, so `wrapAsRole` (which fires `SET LOCAL ROLE` right after any
 * `BEGIN` it observes) backs both: the returned client's own internal
 * `BEGIN` gets wp_app applied automatically, and `ctx.db`'s single
 * `getUserTotpState` SELECT runs inside its own wp_app-scoped transaction
 * the same way. `enrolConfirm` only ever calls `ctx.pool.connect()` (never
 * `ctx.pool.query(...)` directly) - `TotpDbPool` extending `TenantQueryable`
 * still requires a `.query` method to type-check, so the passthrough below
 * exists purely to satisfy that shape; it is never actually invoked by
 * `enrolConfirm`.
 */
export async function runEnrolConfirmAsWpApp(
  pool: ReturnType<typeof createPool>,
  totpCtx: Omit<TotpCtx, 'db' | 'pool'>,
  userId: string,
  code: string,
): Promise<EnrolConfirmResult> {
  const wpAppConnect = wrapAsRole(pool, 'wp_app');
  const dbClient = await wpAppConnect.connect();
  await dbClient.query('BEGIN');
  const wpAppPool = { ...wpAppConnect, query: dbClient.query.bind(dbClient) };

  try {
    const result = await enrolConfirm({ ...totpCtx, db: dbClient, pool: wpAppPool }, userId, code);
    await dbClient.query('COMMIT');
    return result;
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
}
