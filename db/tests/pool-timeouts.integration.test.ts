import { describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { resolveDatabaseUrl } from './helpers/db-url.js';

/**
 * PRE-STEP A (P08 U5): proves `CreatePoolOptions.statementTimeoutMs` is
 * wired through to Postgres via the connection `options` parameter, so a
 * runaway query is bounded at the pool level rather than relying on
 * application-level timeouts.
 */
describe('createPool statement timeout', () => {
  it('pg_leg_is_bounded', async () => {
    const pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'wp-db-tests-pool-timeout',
      statementTimeoutMs: 500,
    });

    try {
      await expect(pool.query('SELECT pg_sleep(2)')).rejects.toMatchObject({
        code: '57014', // query_canceled (statement timeout)
      });
    } finally {
      await pool.end();
    }
  });
});
