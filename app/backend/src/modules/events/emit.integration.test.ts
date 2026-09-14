import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { emit } from './emit.js';

/**
 * emit.integration.test.ts (P15 U2, step 4; extended P15 U4, step 5) -
 * real-Postgres proof of the one honest claim a unit test with a fake `tx`
 * cannot make: a ROLLED BACK business transaction that called `emit()`
 * leaves ZERO outbox rows behind AND fires no relay-wake NOTIFY either
 * (ADR 0010: "Business change + outbox row commit in one transaction";
 * Postgres's own semantics - `pg_notify` inside a transaction only actually
 * notifies LISTENers on COMMIT, never on ROLLBACK). `outbox_events` has no
 * FK to `clients` (see migration 0041's own column list), so a fresh random
 * `clientId` per test is enough - no tenant seed needed. The end-to-end
 * durable publish path (row -> relay -> SSE frame) is proven separately by
 * the relay unit's own integration tests (P15 U4,
 * `roles/relay.integration.test.ts`).
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('emit (P15 U2, real Postgres)', () => {
  it('emit_writes_the_row_on_the_callers_transaction_and_commits_it', async () => {
    const clientId = randomUUID();
    const instanceId = randomUUID();

    await tenantDb.withTenant(clientId, async (tx) => {
      await emit(tx, {
        clientId,
        instanceId,
        type: 'instance.health_changed',
        entityId: instanceId,
        payload: {
          instanceId,
          healthState: 'connected',
          pauseReason: null,
          needsUserAction: false,
        },
        fanout: ['sse'],
      });
    });

    const rows = await pool.query(
      'SELECT event_type, published_at FROM outbox_events WHERE client_id = $1',
      [clientId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.event_type).toBe('instance.health_changed');
    expect(rows.rows[0]?.published_at).toBeNull();

    await pool.query('DELETE FROM outbox_events WHERE client_id = $1', [clientId]);
  });

  it('a_rolled_back_business_transaction_publishes_no_event', async () => {
    const clientId = randomUUID();
    const instanceId = randomUUID();

    await expect(
      tenantDb.withTenant(clientId, async (tx) => {
        await emit(tx, {
          clientId,
          instanceId,
          type: 'instance.health_changed',
          entityId: instanceId,
          payload: {
            instanceId,
            healthState: 'connected',
            pauseReason: null,
            needsUserAction: false,
          },
          fanout: ['sse'],
        });

        throw new Error('injected business-transaction failure after emit');
      }),
    ).rejects.toThrow('injected business-transaction failure after emit');

    const rows = await pool.query('SELECT id FROM outbox_events WHERE client_id = $1', [clientId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('a_committed_emit_fires_exactly_one_wp_outbox_wake_notify', async () => {
    const listenerClient = await pool.connect();
    const notifications: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstNotify = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    listenerClient.on('notification', (msg) => {
      if (msg.channel === 'wp_outbox_wake') {
        notifications.push(msg.payload ?? '');
        resolveFirst?.();
      }
    });
    await listenerClient.query('LISTEN wp_outbox_wake');

    try {
      const clientId = randomUUID();
      const instanceId = randomUUID();

      await tenantDb.withTenant(clientId, async (tx) => {
        await emit(tx, {
          clientId,
          instanceId,
          type: 'instance.health_changed',
          entityId: instanceId,
          payload: {
            instanceId,
            healthState: 'connected',
            pauseReason: null,
            needsUserAction: false,
          },
          fanout: ['sse'],
        });
      });

      // Deterministic: waits on the notification event itself (resolved
      // from inside the `on('notification', ...)` handler above), never an
      // arbitrary sleep - same discipline as redis-bridge.edge.test.ts's
      // `droppedSignal`.
      await firstNotify;

      expect(notifications).toEqual(['']);

      await pool.query('DELETE FROM outbox_events WHERE client_id = $1', [clientId]);
    } finally {
      await listenerClient.query('UNLISTEN wp_outbox_wake');
      listenerClient.release();
    }
  });

  it('a_rolled_back_emit_fires_no_wp_outbox_wake_notify', async () => {
    const listenerClient = await pool.connect();
    const notifications: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstNotify = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    listenerClient.on('notification', (msg) => {
      if (msg.channel === 'wp_outbox_wake') {
        notifications.push(msg.payload ?? '');
        resolveFirst?.();
      }
    });
    await listenerClient.query('LISTEN wp_outbox_wake');

    try {
      const rolledBackClientId = randomUUID();
      const rolledBackInstanceId = randomUUID();

      await expect(
        tenantDb.withTenant(rolledBackClientId, async (tx) => {
          await emit(tx, {
            clientId: rolledBackClientId,
            instanceId: rolledBackInstanceId,
            type: 'instance.health_changed',
            entityId: rolledBackInstanceId,
            payload: {
              instanceId: rolledBackInstanceId,
              healthState: 'connected',
              pauseReason: null,
              needsUserAction: false,
            },
            fanout: ['sse'],
          });

          throw new Error('injected business-transaction failure after emit');
        }),
      ).rejects.toThrow('injected business-transaction failure after emit');

      // Proves silence not by racing a fixed timer, but by committing a
      // SECOND, real emit right after and waiting for THAT notify - if the
      // rolled-back transaction's NOTIFY had fired, it would have arrived
      // (LISTEN/NOTIFY on one connection is delivered in commit order) well
      // before this second one, so observing exactly one notification total
      // (this second one) proves the first (rolled back) fired none.
      const committedClientId = randomUUID();
      const committedInstanceId = randomUUID();
      await tenantDb.withTenant(committedClientId, async (tx) => {
        await emit(tx, {
          clientId: committedClientId,
          instanceId: committedInstanceId,
          type: 'instance.health_changed',
          entityId: committedInstanceId,
          payload: {
            instanceId: committedInstanceId,
            healthState: 'connected',
            pauseReason: null,
            needsUserAction: false,
          },
          fanout: ['sse'],
        });
      });

      await firstNotify;

      expect(notifications).toEqual(['']);

      await pool.query('DELETE FROM outbox_events WHERE client_id = $1', [committedClientId]);
    } finally {
      await listenerClient.query('UNLISTEN wp_outbox_wake');
      listenerClient.release();
    }
  });
});
