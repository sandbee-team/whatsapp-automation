import { createPool } from '@wp/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../platform/db/db-url.js';
import { runOutboxCleanup } from '../modules/events/cleanup.js';
import {
  cleanupOutboxRows,
  newClientId,
  newInstanceId,
  seedOutboxRow,
  type TestPool,
} from './__tests__/relay-test-helpers.js';

/**
 * roles/relay-cleanup-role.integration.test.ts (P15 C1 FIX F5 / MAJ-3,
 * sibling split of relay-cleanup-and-qr.integration.test.ts for the 300-line
 * cap - not a behavioural boundary, same idiom as
 * `session-worker-discovery-wiring.ts`) - proves `runOutboxCleanup` actually
 * succeeds when run under the real, narrowly-granted `wp_relay` role
 * (SELECT/UPDATE/DELETE/INSERT on `outbox_events` only, migrations
 * 0041/0042), not only against the dev/test pool's own privileged connecting
 * role.
 *
 * `roles/relay.ts` used to call `runOutboxCleanup({ pool })` directly
 * against the raw pool - it only ever "worked" because the dev pool's own
 * connecting role happens to be privileged, contradicting `cleanup.ts`'s own
 * documented contract ("caller is responsible for SET LOCAL ROLE wp_relay
 * ... same convention as drainOnce").
 *
 * NOT a role entrypoint (see `relay.integration.test.ts`'s own note on
 * `scripts/check-role-boot.ts`'s glob) - no `assertDbPreconditionsOrExit`
 * call here; that gate belongs to `roles/relay.ts`'s own `main()`.
 */

const pool: TestPool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'app-backend-tests',
}) as unknown as TestPool;

afterAll(async () => {
  await (pool as unknown as { end: () => Promise<void> }).end();
});

let seededClientIds: string[] = [];

afterEach(async () => {
  await cleanupOutboxRows(pool, seededClientIds);
  seededClientIds = [];
});

describe('runOutboxCleanup - runs under SET LOCAL ROLE wp_relay (F5 / MAJ-3)', () => {
  it('the_sweep_succeeds_under_the_real_wp_relay_role_not_the_raw_privileged_pool', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    // Exactly ONE eligible row scoped to this test's own clientId - since
    // the wp_relay-scoped connection only ever operates on rows THIS test
    // controls being present (no other test seeds an old-published row
    // under a concurrently-held wp_relay-role transaction at the same
    // instant), an exact `toBe(1)` is safe here (unlike the cross-tenant
    // sweep in the sibling file, which needs the 5001-row technique to stay
    // exact under concurrent test files).
    const oldPublishedId = await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'instance.health_changed',
      entityId: instanceId,
      payload: { instanceId, healthState: 'connected', pauseReason: null, needsUserAction: false },
      coalesceKey: `instance:${instanceId}:state`,
      fanout: ['sse'],
      publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    const client = await pool.connect();
    let deletedCount: number;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_relay');
      deletedCount = await runOutboxCleanup({ pool: client, limit: 1 });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    expect(deletedCount).toBe(1);

    const remaining = await pool.query<{ id: string }>(
      'SELECT id FROM outbox_events WHERE id = $1',
      [oldPublishedId],
    );
    expect(remaining.rows).toHaveLength(0);
  });
});
