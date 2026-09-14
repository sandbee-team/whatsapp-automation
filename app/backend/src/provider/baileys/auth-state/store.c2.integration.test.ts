import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { tenantKey } from '../../../platform/redis.js';
import {
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  buildStore,
  makeNoopPorts,
  PROBE_WORKER_ID,
  seedTenantInstanceAndLease,
  TEST_ENV,
  type StoreTestHandles,
} from './__tests__/store-fixtures.js';
import { StoreFencedError, type SessionStoreDb } from './types.js';
import { createSignalRedisRepo } from './redis-repo.js';
import { createAuthCodec } from './codec.js';
import { createEncryptedAuthStore } from './store.js';
import { FileKeyProvider } from '@wp/server-kit/crypto';

/**
 * store.c2.integration.test.ts (P07 close step C2) - adversarial pass over
 * the encrypted auth store's invariant surface NOT already covered by the E3
 * edge pass (empty/huge inputs, fence boundaries, classifyWriteMiss races,
 * retry exhaustion, chain wedging, TTL/LRU boundaries, codec fail-closed,
 * two-tenant probes - see edge-cases.integration.test.ts). Three of six
 * targeted categories live here: crash mid-transaction, replay of an
 * already-applied write, and two concurrent stores for one instance (real
 * takeover). The takeover category lives in the sibling file
 * `store.c2-takeover.integration.test.ts`, and the remaining three (retry
 * storm, a slow-rather-than-down Redis dependency, session-epoch stamping
 * after a bump) live in `store.c2-more.integration.test.ts` (both splits
 * purely to stay under the repo's `max-lines` guard).
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

describe('C2: crash mid-multi-statement purge transaction', () => {
  it('a_connection_kill_between_the_deletes_and_the_epoch_bump_rolls_back_fully_and_leaves_redis_untouched', async () => {
    const fence = 10n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const store = buildStore(handles, { instanceId, clientId, fence });
    await store.saveCreds({ creds: { a: 1 }, expectedVersion: 0n, fence });
    await store.setKeys({ session: { 's-1': new Uint8Array([1, 2, 3]) } }, fence);

    const sigHashKey = tenantKey(TEST_ENV, clientId, 'sig', 'i', instanceId, 'h', 'session');
    const sigBefore = await handles.redisSig.hgetall(sigHashKey);
    expect(Object.keys(sigBefore)).toHaveLength(1);

    // Wrap the pool so `.connect()` returns a client whose THIRD query
    // (the epoch bump, after BEGIN + the two deletes) throws as if the
    // connection died - simulating a crash between the deletes and the
    // epoch bump exactly as the task specifies.
    let queryCount = 0;
    const realClient = await handles.pool.connect();
    const killingClient = {
      query: (...args: Parameters<typeof realClient.query>) => {
        queryCount += 1;
        // sequence: 1=BEGIN, 2=creds delete, 3=keys delete, 4=epoch bump
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
    const ports = makeNoopPorts();
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
      ports,
      metrics: {
        incrementHit: vi.fn(),
        incrementMiss: vi.fn(),
        incrementEvicted: vi.fn(),
        incrementDecryptFailure: vi.fn(),
      } as never,
    });

    await expect(killingStore.purge(fence)).rejects.toThrow('SIMULATED_CONNECTION_KILL');

    // Full rollback: creds/keys rows still present, epoch NOT bumped, no audit row.
    const creds = await handles.pool.query(
      'SELECT 1 FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    expect(creds.rows.length).toBe(1);
    const instanceRow = await handles.pool.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(instanceRow.rows[0]?.session_epoch).toBe(0);
    const auditRows = await handles.pool.query('SELECT 1 FROM audit_logs WHERE client_id = $1', [
      clientId,
    ]);
    expect(auditRows.rows.length).toBe(0);

    // Redis hashes untouched - purgeInstance() is only called AFTER commit,
    // so a crash before commit must never have reached Redis at all.
    const sigAfter = await handles.redisSig.hgetall(sigHashKey);
    expect(sigAfter).toEqual(sigBefore);

    // `runPurge`'s own `finally` already released `killingClient` (which
    // forwards `.release()` to `realClient`) once - releasing again here
    // would double-release the same underlying pg-pool client.
  });
});

describe('C2: replay of an already-applied write', () => {
  it('saveCreds_replayed_with_the_same_expectedVersion_after_a_successful_save_is_last_writer_wins_via_reload_retry', async () => {
    // (a) Replaying saveCreds with the SAME expectedVersion after a
    // successful save: the first write lands (cred_version 0 -> 1). The
    // exact-same call replayed hits version_conflict (server is now at 1,
    // caller still says 0), reloads, and retries with the fresh version -
    // landing a SECOND write (cred_version 1 -> 2) with the SAME payload.
    // This documents saveCreds as last-writer-wins for the live owner, never
    // an error surfaced to the caller.
    const fence = 11n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const store = buildStore(handles, { instanceId, clientId, fence });
    const args = { creds: { replay: true }, expectedVersion: 0n, fence };

    await store.saveCreds(args);
    const afterFirst = await handles.pool.query<{ cred_version: string }>(
      'SELECT cred_version FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    expect(afterFirst.rows[0]?.cred_version).toBe('1');

    // Replay the SAME args object (same expectedVersion=0n) on the same
    // store - a fresh internal retry-loop invocation, not the same
    // in-flight call - it must not throw, and it lands a second write.
    await store.saveCreds(args);
    const afterReplay = await handles.pool.query<{ cred_version: string }>(
      'SELECT cred_version FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    expect(afterReplay.rows[0]?.cred_version).toBe('2');

    const loaded = await store.loadCreds();
    expect(loaded).toEqual({ replay: true });
  });

  it('purge_replayed_after_a_successful_purge_is_a_true_no_op_no_second_epoch_bump_no_second_audit', async () => {
    // FIX-A C2-F1: purge is idempotent - replaying at the SAME fence after a
    // successful purge is a true no-op (deletes find nothing,
    // session-lease-is-valid.sql proves the fence/owner is still live, so
    // the epoch bump/audit insert are both skipped, `{ purged: false }`).
    //
    // FIX-B WARNING: a SUCCESSFUL purge now terminally fences ITS OWN store
    // (`markPurged`, see PurgeResult's doc comment), so the replay below uses
    // a FRESH store instance for the same (instanceId, clientId, fence) - the
    // realistic shape (a worker rebuilds its store and retries after an
    // uncertain outcome), not a second call on the already-purged object
    // (which now throws StoreFencedError - asserted separately below).
    const fence = 12n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const store = buildStore(handles, { instanceId, clientId, fence });
    await store.saveCreds({ creds: { a: 1 }, expectedVersion: 0n, fence });

    const firstPurgeResult = await store.purge(fence);
    expect(firstPurgeResult).toEqual({ purged: true });
    const afterFirstPurge = await handles.pool.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(afterFirstPurge.rows[0]?.session_epoch).toBe(1);
    const auditAfterFirst = await handles.pool.query(
      'SELECT 1 FROM audit_logs WHERE client_id = $1',
      [clientId],
    );
    expect(auditAfterFirst.rows.length).toBe(1);

    // The first store is now terminally fenced by its own successful purge.
    await expect(store.purge(fence)).rejects.toThrow(StoreFencedError);

    // Fresh store, same (instanceId, clientId, fence) - current_fence was
    // never changed by purge (only session_epoch was), so it's still live.
    const replayStore = buildStore(handles, { instanceId, clientId, fence });
    const secondPurgeResult = await replayStore.purge(fence);
    expect(secondPurgeResult).toEqual({ purged: false });

    const afterSecondPurge = await handles.pool.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    const auditAfterSecond = await handles.pool.query(
      'SELECT 1 FROM audit_logs WHERE client_id = $1',
      [clientId],
    );

    // No second epoch bump, no second audit row - a true no-op.
    expect(afterSecondPurge.rows[0]?.session_epoch).toBe(1);
    expect(auditAfterSecond.rows.length).toBe(1);
  });
});
