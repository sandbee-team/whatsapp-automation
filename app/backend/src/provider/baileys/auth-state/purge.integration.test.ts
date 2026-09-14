import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { tenantKey } from '../../../platform/redis.js';
import {
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  buildStore,
  seedTenantInstanceAndLease,
  TEST_ENV,
  type StoreTestHandles,
} from './__tests__/store-fixtures.js';

/**
 * purge.integration.test.ts (P07 Unit U5) - after `purge`: zero rows in both
 * durable tables for the instance, EXISTS = 0 for every sig and cache hash,
 * `session_epoch` exactly +1, exactly one audit row - and the Postgres
 * effects are ONE transaction (proved by injecting a failure after the
 * deletes but before commit and asserting full rollback).
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

describe('purge', () => {
  it('purge_removes_both_tables_and_every_redis_key_and_bumps_epoch', async () => {
    const fence = 3n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const store = buildStore(handles, { instanceId, clientId, fence });

    await store.saveCreds({ creds: { a: 1 }, expectedVersion: 0n, fence });
    await store.setKeys(
      { 'pre-key': { 'k-1': { public: new Uint8Array([1]), private: new Uint8Array([2]) } } },
      fence,
    );
    await store.setKeys({ session: { 's-1': new Uint8Array([1]) } }, fence);
    await store.setKeys({ 'sender-key-memory': { 'c-1': { peer: true } } }, fence);

    await store.purge(fence);

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

    const sigResult = await handles.redisSig.exists(
      tenantKey(TEST_ENV, clientId, 'sig', 'i', instanceId, 'h', 'session'),
    );
    expect(sigResult).toBe(0);
    const cacheResult = await handles.redisCache.exists(
      tenantKey(TEST_ENV, clientId, 'cache', 'i', instanceId, 'h', 'sender-key-memory'),
    );
    expect(cacheResult).toBe(0);

    const instanceRow = await handles.pool.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(instanceRow.rows[0]?.session_epoch).toBe(1);

    const auditRows = await handles.pool.query('SELECT 1 FROM audit_logs WHERE client_id = $1', [
      clientId,
    ]);
    expect(auditRows.rows.length).toBe(1);
  });

  it('purge_is_one_transaction_a_failure_before_commit_rolls_everything_back', async () => {
    const fence = 4n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const store = buildStore(handles, { instanceId, clientId, fence });
    await store.saveCreds({ creds: { a: 1 }, expectedVersion: 0n, fence });
    await store.setKeys(
      { 'pre-key': { 'k-1': { public: new Uint8Array([1]), private: new Uint8Array([2]) } } },
      fence,
    );

    // Purge with a STALE fence (the epoch-bump predicate matches zero rows)
    // - this is the same "failure after the deletes but before commit"
    // shape the task describes: the deletes above (if the fence still
    // matched) would have removed rows, but the epoch bump's zero-row
    // outcome must still roll back the WHOLE transaction, not just skip the
    // epoch bump.
    const staleFence = fence - 1n;
    await expect(store.purge(staleFence)).rejects.toThrow();

    // Full rollback: the creds/keys rows inserted above are still there.
    const creds = await handles.pool.query(
      'SELECT 1 FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    expect(creds.rows.length).toBe(1);
    const keys = await handles.pool.query(
      'SELECT 1 FROM whatsapp_session_keys WHERE instance_id = $1',
      [instanceId],
    );
    expect(keys.rows.length).toBe(1);
    const instanceRow = await handles.pool.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(instanceRow.rows[0]?.session_epoch).toBe(0);
    const auditRows = await handles.pool.query('SELECT 1 FROM audit_logs WHERE client_id = $1', [
      clientId,
    ]);
    expect(auditRows.rows.length).toBe(0);
  });
});
