import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import {
  buildStore,
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  makeNoopPorts,
  PROBE_WORKER_ID,
  seedTenantInstanceAndLease,
  TEST_ENV,
  type StoreTestHandles,
} from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import { createAuthCodec } from '../../provider/baileys/auth-state/codec.js';
import { createSignalRedisRepo } from '../../provider/baileys/auth-state/redis-repo.js';
import { createEncryptedAuthStore } from '../../provider/baileys/auth-state/store.js';
import type { SessionStoreDb } from '../../provider/baileys/auth-state/types.js';
import { runLoggedOutFlow, type InstanceServiceDeps } from './service.js';
import { ctxFor } from './__tests__/instances-test-helpers.js';

/**
 * instance-transitions.logged-out-purge.integration.test.ts (P08 Unit U4) -
 * the `logged_out` flow end to end against a REAL P07 `EncryptedAuthStore`
 * (reusing its own fixtures, per the task): creds+keys seeded, then
 * `runLoggedOutFlow` (markLoggedOut -> audit -> purge), then creds+keys rows
 * gone, `session_epoch` +1, audit rows present. A second pass injects a
 * connection kill INSIDE the purge transaction (same technique as
 * `store.c2.integration.test.ts`) and asserts the purge transaction rolls
 * back fully while `markLoggedOut`'s own write (a separate, already-
 * committed statement) stays landed - see service.ts's header comment for
 * the documented crash-window ordering (state-first; purge is idempotent
 * since P07).
 */

let handles: StoreTestHandles;
let probeClientIds: string[] = [];

beforeAll(() => {
  handles = createStoreTestHandles();
});

afterAll(async () => {
  await disposeStoreTestHandles(handles);
});

afterEach(async () => {
  await cleanupProbeClients(handles.pool, probeClientIds);
  probeClientIds = [];
});

describe('logged_out purges auth material and bumps session_epoch atomically', () => {
  it('logged_out_purges_auth_material_and_bumps_session_epoch_atomically', async () => {
    const fence = 21n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const store = buildStore(handles, { instanceId, clientId, fence });
    await store.saveCreds({ creds: { a: 1 }, expectedVersion: 0n, fence });
    await store.setKeys(
      { 'pre-key': { 'k-1': { public: new Uint8Array([1]), private: new Uint8Array([2]) } } },
      fence,
    );

    const deps: InstanceServiceDeps = {
      ctx: ctxFor(handles.pool, clientId),
      auditSql: handles.pool as never,
    };

    await runLoggedOutFlow(deps, {
      instanceId,
      fence,
      workerId: PROBE_WORKER_ID,
      authStore: store,
    });

    const creds = await handles.pool.query(
      'SELECT 1 FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    expect(creds.rows.length).toBe(0);

    const keys = await handles.pool.query(
      'SELECT 1 FROM whatsapp_session_keys WHERE instance_id = $1',
      [instanceId],
    );
    expect(keys.rows.length).toBe(0);

    const instanceRow = await handles.pool.query<{
      session_epoch: number;
      health_state: string;
      link_state: string;
    }>('SELECT session_epoch, health_state, link_state FROM whatsapp_instances WHERE id = $1', [
      instanceId,
    ]);
    expect(instanceRow.rows[0]?.session_epoch).toBe(1);
    expect(instanceRow.rows[0]?.health_state).toBe('logged_out');
    expect(instanceRow.rows[0]?.link_state).toBe('unlinked');

    const auditRows = await handles.pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY created_at`,
      [instanceId],
    );
    // One 'instance.logged_out' row (this module) plus one 'session.purge'
    // row (P07's own purge transaction) - both are present after a real
    // purge.
    expect(auditRows.rows.map((row) => row.action)).toEqual([
      'instance.logged_out',
      'session.purge',
    ]);

    // P17 U6 (step 5) - exactly ONE `instance_logged_out` notification.
    const notificationRows = await handles.pool.query<{
      kind: string;
      requires_user_action: boolean;
    }>(`SELECT kind, requires_user_action FROM notifications WHERE instance_id = $1`, [instanceId]);
    expect(notificationRows.rows).toHaveLength(1);
    expect(notificationRows.rows[0]?.kind).toBe('instance_logged_out');
    expect(notificationRows.rows[0]?.requires_user_action).toBe(true);
  });

  it('a_connection_kill_inside_the_purge_tx_rolls_back_the_purge_fully_while_markLoggedOut_stays_landed', async () => {
    const fence = 22n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const store = buildStore(handles, { instanceId, clientId, fence });
    await store.saveCreds({ creds: { a: 1 }, expectedVersion: 0n, fence });
    await store.setKeys({ session: { 's-1': new Uint8Array([1, 2, 3]) } }, fence);

    // Same "killing client" technique as store.c2.integration.test.ts: the
    // FOURTH query on the connection `purge`'s own transaction opens
    // (1=BEGIN, 2=creds delete, 3=keys delete, 4=epoch bump) throws as if
    // the connection died.
    let queryCount = 0;
    const realClient = await handles.pool.connect();
    const killingClient = {
      query: (...args: Parameters<typeof realClient.query>) => {
        queryCount += 1;
        if (queryCount === 4) {
          throw new Error('SIMULATED_CONNECTION_KILL');
        }
        return (realClient.query as (...a: unknown[]) => unknown)(...args);
      },
      release: (err?: Error) => realClient.release(err),
    };
    const killingDb: SessionStoreDb = {
      query: (sql, params) => handles.pool.query(sql, params) as never,
      connect: async () =>
        killingClient as unknown as Awaited<ReturnType<SessionStoreDb['connect']>>,
    };

    const provider = new FileKeyProvider({
      ringPath: handles.keyRingPath,
      mountedPurposes: ['session'],
    });
    const codec = createAuthCodec({ provider, encVersion: 1 });
    const redisRepo = createSignalRedisRepo({
      redisSig: handles.redisSig,
      redisCache: handles.redisCache,
      env: TEST_ENV,
    });
    const killingStore = createEncryptedAuthStore({
      db: killingDb,
      redisRepo,
      codec,
      identity: {
        instanceId,
        clientId,
        sessionEpoch: 0,
        fence,
        env: TEST_ENV,
        workerId: PROBE_WORKER_ID,
      },
      ports: makeNoopPorts(),
      metrics: {
        incrementHit: vi.fn(),
        incrementMiss: vi.fn(),
        incrementEvicted: vi.fn(),
        incrementDecryptFailure: vi.fn(),
      } as never,
    });

    const deps: InstanceServiceDeps = {
      ctx: ctxFor(handles.pool, clientId),
      auditSql: handles.pool as never,
    };

    await expect(
      runLoggedOutFlow(deps, {
        instanceId,
        fence,
        workerId: PROBE_WORKER_ID,
        authStore: killingStore,
      }),
    ).rejects.toThrow('SIMULATED_CONNECTION_KILL');

    // markLoggedOut's own write already committed as its own statement -
    // stays landed even though the LATER purge transaction rolled back.
    const instanceRow = await handles.pool.query<{ health_state: string; link_state: string }>(
      'SELECT health_state, link_state FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(instanceRow.rows[0]).toEqual({ health_state: 'logged_out', link_state: 'unlinked' });

    // The purge transaction rolled back fully: creds/keys rows still
    // present, epoch NOT bumped.
    const creds = await handles.pool.query(
      'SELECT 1 FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    expect(creds.rows.length).toBe(1);
    const epochRow = await handles.pool.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(epochRow.rows[0]?.session_epoch).toBe(0);
  });
});
