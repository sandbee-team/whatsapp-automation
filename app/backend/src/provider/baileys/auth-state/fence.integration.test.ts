import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { tenantKey } from '../../../platform/redis.js';
import {
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  buildStore,
  makeNoopPorts,
  seedTenantInstanceAndLease,
  TEST_ENV,
  type StoreTestHandles,
} from './__tests__/store-fixtures.js';
import { FenceConflictError } from './types.js';
import { createSignalRedisRepo } from './redis-repo.js';

/**
 * fence.integration.test.ts (P07 Unit U5) - `stale_fence_cannot_save_
 * setkeys_or_purge` (mandatory suite test 4, engine half): seed a live owner
 * at fence F with saved creds + durable keys + sig-tier Redis hashes; a
 * second store built at fence F-1 attempts `saveCreds`, `setKeys` (durable
 * AND signal), and `purge` - all three fail with `FenceConflictError`/zero
 * rows, and afterwards the live session's credentials row, `whatsapp_
 * session_keys` rows, and Redis hash contents are BYTE-IDENTICAL to before.
 *
 * MECHANISM for the signal-path fence check (documented per the task's
 * instruction): `store.ts`'s `setKeys` re-reads `instance_lease_state.
 * current_fence` via `pgRepo.classifyWriteMiss` (the SAME live-fence source
 * of truth the durable path uses) BEFORE it ever calls `redisRepo.setKeys` -
 * a stale caller is caught and self-fenced at that re-read, so it never
 * reaches Redis at all.
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

describe('fence', () => {
  it('stale_fence_cannot_save_setkeys_or_purge', async () => {
    const liveFence = 5n;
    const staleFence = liveFence - 1n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, liveFence);
    probeClientIds.push(clientId);

    const liveStore = buildStore(handles, { instanceId, clientId, fence: liveFence });

    // Seed the live owner's state.
    await liveStore.saveCreds({ creds: { seq: 1 }, expectedVersion: 0n, fence: liveFence });
    await liveStore.setKeys(
      { 'pre-key': { 'k-1': { public: new Uint8Array([1]), private: new Uint8Array([2]) } } },
      liveFence,
    );
    await liveStore.setKeys({ session: { 's-1': new Uint8Array([1, 2, 3]) } }, liveFence);

    const credsBefore = await handles.pool.query(
      'SELECT * FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    const keysBefore = await handles.pool.query(
      'SELECT * FROM whatsapp_session_keys WHERE instance_id = $1 ORDER BY key_type, key_id',
      [instanceId],
    );
    const sigHashKey = tenantKey(TEST_ENV, clientId, 'sig', 'i', instanceId, 'h', 'session');
    const sigBefore = await handles.redisSig.hgetall(sigHashKey);

    // A SECOND store, built at the STALE fence (F-1).
    const staleStorePorts = makeNoopPorts();
    const staleStore = buildStore(
      handles,
      { instanceId, clientId, fence: staleFence },
      { ports: staleStorePorts },
    );

    await expect(
      staleStore.saveCreds({ creds: { seq: 2 }, expectedVersion: 1n, fence: staleFence }),
    ).rejects.toThrow(FenceConflictError);

    const staleDurablePorts = makeNoopPorts();
    const staleStoreDurable = buildStore(
      handles,
      { instanceId, clientId, fence: staleFence },
      { ports: staleDurablePorts },
    );
    await expect(
      staleStoreDurable.setKeys(
        { 'pre-key': { 'k-2': { public: new Uint8Array([3]), private: new Uint8Array([4]) } } },
        staleFence,
      ),
    ).rejects.toThrow(FenceConflictError);

    const staleSignalPorts = makeNoopPorts();
    const staleStoreSignal = buildStore(
      handles,
      { instanceId, clientId, fence: staleFence },
      { ports: staleSignalPorts },
    );
    await expect(
      staleStoreSignal.setKeys({ session: { 's-2': new Uint8Array([9, 9]) } }, staleFence),
    ).rejects.toThrow(FenceConflictError);

    const stalePurgePorts = makeNoopPorts();
    const staleStorePurge = buildStore(
      handles,
      { instanceId, clientId, fence: staleFence },
      { ports: stalePurgePorts },
    );
    await expect(staleStorePurge.purge(staleFence)).rejects.toThrow(FenceConflictError);

    // Every stale write self-fenced (called onFenceConflict + releaseLease
    // exactly once) rather than silently no-oping.
    for (const ports of [staleStorePorts, staleDurablePorts, staleSignalPorts, stalePurgePorts]) {
      expect(ports.onFenceConflict).toHaveBeenCalledTimes(1);
      expect(ports.releaseLease).toHaveBeenCalledTimes(1);
    }

    // The live session's state is byte-identical to before every stale attempt.
    const credsAfter = await handles.pool.query(
      'SELECT * FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    expect(credsAfter.rows).toEqual(credsBefore.rows);

    const keysAfter = await handles.pool.query(
      'SELECT * FROM whatsapp_session_keys WHERE instance_id = $1 ORDER BY key_type, key_id',
      [instanceId],
    );
    expect(keysAfter.rows).toEqual(keysBefore.rows);

    const sigAfter = await handles.redisSig.hgetall(sigHashKey);
    expect(sigAfter).toEqual(sigBefore);

    // The live store can still read/write normally afterward (unaffected by
    // the stale owner's rejected attempts).
    const stillLoadable = await liveStore.loadCreds();
    expect(stillLoadable).not.toBeNull();
  });

  it('WARNING_3_regression_a_redis_fence_gate_pre_set_to_a_newer_fence_rejects_a_setKeys_at_the_older_fence_and_it_never_lands_in_the_hash', async () => {
    // The TOCTOU regression test: `store-keys.ts`'s pre-write
    // `classifyWriteMiss` check can only prove the caller's fence was
    // current AT THE TIME OF THE CHECK - a takeover minting a NEW fence
    // could land in the window between that check and the actual Redis
    // write. `redis-repo.ts`'s Lua fence gate (WARNING-3) closes this by
    // keeping a monotonic high-water-mark per (tier, instance) in Redis
    // itself. Here we simulate a takeover having ALREADY gated fence F+1
    // through (pre-setting the gate key directly, bypassing the store
    // entirely) and then attempt an ordinary fence-F setKeys through the
    // store - it must be rejected and never touch the hash at all, even
    // though the caller's own `classifyWriteMiss` pre-check would otherwise
    // have seen a live Postgres lease fence.
    const fence = 60n;
    const newerFence = fence + 1n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const redisRepo = createSignalRedisRepo({
      redisSig: handles.redisSig,
      redisCache: handles.redisCache,
      env: TEST_ENV,
    });
    // Simulate the takeover's gated write having already happened for a
    // DIFFERENT session field, gating the per-instance sig-tier high-water
    // mark up to `newerFence`.
    await redisRepo.setKeys(
      { clientId, instanceId },
      [{ keyType: 'session', keyId: 'owned-by-newer-fence', value: Buffer.from([1]) }],
      newerFence,
    );

    const ports = makeNoopPorts();
    const store = buildStore(handles, { instanceId, clientId, fence }, { ports });

    const sigHashKey = tenantKey(TEST_ENV, clientId, 'sig', 'i', instanceId, 'h', 'session');
    const beforeAttempt = await handles.redisSig.hgetall(sigHashKey);

    await expect(
      store.setKeys({ session: { 's-toctou': new Uint8Array([9, 9]) } }, fence),
    ).rejects.toThrow(FenceConflictError);

    expect(ports.onFenceConflict).toHaveBeenCalledTimes(1);
    expect(ports.releaseLease).toHaveBeenCalledTimes(1);

    // The older-fence write never landed - the hash is byte-identical to
    // before the rejected attempt (only the newer-fence field is present).
    const afterAttempt = await handles.redisSig.hgetall(sigHashKey);
    expect(afterAttempt).toEqual(beforeAttempt);
    expect(Object.keys(afterAttempt)).toEqual(['owned-by-newer-fence']);
  });
});
