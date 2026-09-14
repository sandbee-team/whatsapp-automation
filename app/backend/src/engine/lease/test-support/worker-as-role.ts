import type { createPool, WorkerDb, WorkerQueryable } from '@wp/db';

/**
 * worker-as-role.ts (C1 fix, test-support only) - composes `SET LOCAL ROLE`
 * (the same pattern `platform/db/test-support/wp-app-role.ts` uses for
 * tenant-scoped proofs) with `@wp/db`'s `withWorker` GUC-setting shape, on
 * ONE pinned connection/transaction: role first, then the `app.worker_id`
 * GUC, matching production `createWorkerDb`'s statement order.
 *
 * Exists because `createTenantDb`/`createWorkerDb` both require a real
 * `pg.Pool` (not `wrapAsRole`'s `{connect(): Promise<WrappedClient>}`
 * shape), so the dev/test pool's own role (superuser, BYPASSRLS) would make
 * a `createWorkerDb(pool)` proof vacuous for RLS purposes - a real `wp_app`
 * role proof needs `SET LOCAL ROLE wp_app` run on the SAME connection
 * before the GUC and the statement, which this helper provides as a
 * `WorkerDb` so it is a drop-in replacement for `renewBatch`'s first
 * argument in a test.
 */
export function createWorkerDbAsRole(pool: ReturnType<typeof createPool>, role: string): WorkerDb {
  return {
    async withWorker<T>(workerId: string, fn: (tx: WorkerQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let releaseError: unknown;
      try {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL ROLE ${role}`);
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
