import type { RelayPool, RelayPoolClient } from './relay-loop.js';

/**
 * relay-loop-role.ts (P17 fix round F1, max-lines split) - `withRelayRole`,
 * split out of `relay-loop.ts` purely for line-count headroom (that file has
 * none left after the F1 fix's own additions - same sibling-module idiom as
 * `relay-loop-email-wiring.ts`/`relay-loop-poison.ts`), NOT a logic change.
 *
 * Runs `fn` on one pinned connection, `BEGIN`/`SET LOCAL ROLE wp_relay`/
 * `COMMIT` (or `ROLLBACK`) around it - the relay's own cross-tenant
 * transaction shape, mirroring `platform/db/test-support/wp-app-role.ts`'s
 * `wrapAsRole` idiom but as production code (this role has no per-tenant
 * `app.client_id` GUC to set - `wp_relay` is BYPASSRLS, migration 0041).
 */
export async function withRelayRole<T>(
  pool: RelayPool,
  fn: (client: RelayPoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let releaseError: unknown;
  try {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE wp_relay');
      const result = await fn(client);
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
}
