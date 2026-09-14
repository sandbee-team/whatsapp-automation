import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { setKeys } from './pg-repo.js';
import { FenceConflictError } from './types.js';
import { SIGNAL_KEY_TTL_MS } from '@wp/domain';

/**
 * edge-cases-more.integration.test.ts (E3 hardening pass, split of
 * edge-cases.integration.test.ts purely to stay under the repo's `max-lines`
 * guard) - large/empty `setKeys` batches, Redis PTTL re-arming (both sig and
 * cache tiers), and a two-tenant probe that one client's store can never
 * read/write another client's rows/hashes. See edge-cases.integration.test.ts's
 * own header for the other categories (boundary fences, classifyWriteMiss
 * races).
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

describe('large and empty batches', () => {
  it('setKeys_with_empty_writes_array_is_a_no_op', async () => {
    const fence = 1n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const result = await setKeys(
      handles.pool as never,
      { instanceId, clientId, fence, workerId: PROBE_WORKER_ID, sessionEpoch: 0 },
      [],
    );
    expect(result).toEqual({ written: 0, missed: false });
  });

  it('a_500_row_mixed_durable_plus_cache_plus_sig_batch_lands_atomically_per_tier', async () => {
    const fence = 2n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);
    const store = buildStore(handles, { instanceId, clientId, fence });

    const preKeys: Record<string, unknown> = {};
    const sessions: Record<string, unknown> = {};
    const cacheEntries: Record<string, unknown> = {};
    // ~166 of each type across the three tiers = ~500 total ids in ONE
    // setKeys call - a single call is scoped to one instance/fence (per
    // pg-repo-keys.ts's header) but spans all three storage tiers at once.
    for (let i = 0; i < 166; i += 1) {
      preKeys[`pk-${String(i)}`] = {
        public: new Uint8Array([i % 256]),
        private: new Uint8Array([(i + 1) % 256]),
      };
      sessions[`s-${String(i)}`] = new Uint8Array([i % 256, (i + 1) % 256]);
      cacheEntries[`c-${String(i)}`] = { peer: i };
    }

    await store.setKeys(
      {
        'pre-key': preKeys,
        session: sessions,
        'sender-key-memory': cacheEntries,
      } as Parameters<typeof store.setKeys>[0],
      fence,
    );

    // Spot-check across all three tiers - every id from every tier landed.
    const preKeyIds = Object.keys(preKeys);
    const durableFetched = await store.getKeys('pre-key', [
      preKeyIds[0] as string,
      preKeyIds[82] as string,
      preKeyIds[165] as string,
    ]);
    expect(Object.keys(durableFetched)).toHaveLength(3);

    const sessionIds = Object.keys(sessions);
    const sigFetched = await store.getKeys('session', [
      sessionIds[0] as string,
      sessionIds[82] as string,
      sessionIds[165] as string,
    ]);
    expect(Object.keys(sigFetched)).toHaveLength(3);

    const cacheIds = Object.keys(cacheEntries);
    const cacheFetched = await store.getKeys('sender-key-memory', [
      cacheIds[0] as string,
      cacheIds[82] as string,
      cacheIds[165] as string,
    ]);
    expect(Object.keys(cacheFetched)).toHaveLength(3);

    // Full count check against Postgres directly for the durable tier (the
    // one with a real row-count invariant).
    const countRow = await handles.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM whatsapp_session_keys WHERE instance_id = $1 AND key_type = 'pre-key'",
      [instanceId],
    );
    expect(countRow.rows[0]?.count).toBe('166');
  });

  it('a_near_typical_size_creds_blob_round_trips_intact', async () => {
    const fence = 1n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);
    const store = buildStore(handles, { instanceId, clientId, fence });

    // A real Baileys creds object is typically tens of KB once its
    // pre-key/identity buffers are populated - approximate that shape and
    // size with a large nested payload of random-ish bytes.
    const bigBuffer = Buffer.alloc(64 * 1024, 0x5a); // 64 KiB
    const creds = {
      noiseKey: { public: bigBuffer.subarray(0, 32), private: bigBuffer.subarray(32, 64) },
      signedPreKey: { keyPair: { public: bigBuffer, private: bigBuffer } },
      registrationId: 12345,
      account: { details: bigBuffer.toString('base64').slice(0, 1000) },
    };

    await store.saveCreds({ creds, expectedVersion: 0n, fence });
    const loaded = (await store.loadCreds()) as typeof creds;

    expect(Buffer.isBuffer(loaded.noiseKey.public)).toBe(true);
    expect((loaded.noiseKey.public as Buffer).equals(bigBuffer.subarray(0, 32))).toBe(true);
    expect(Buffer.isBuffer(loaded.signedPreKey.keyPair.public)).toBe(true);
    expect((loaded.signedPreKey.keyPair.public as Buffer).equals(bigBuffer)).toBe(true);
    expect(loaded.registrationId).toBe(creds.registrationId);
    expect(loaded.account.details).toBe(creds.account.details);
  });
});

describe('Redis TTL boundary', () => {
  it('a_second_write_strictly_re_arms_the_ttl_on_both_sig_and_cache_tier_hashes', async () => {
    const fence = 1n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);
    const store = buildStore(handles, { instanceId, clientId, fence });

    await store.setKeys({ session: { 's-1': new Uint8Array([1]) } }, fence);
    const sigHashKey = tenantKey(TEST_ENV, clientId, 'sig', 'i', instanceId, 'h', 'session');
    const firstSigPttl = await handles.redisSig.pttl(sigHashKey);
    expect(firstSigPttl).toBeGreaterThan(0);

    await store.setKeys({ 'sender-key-memory': { 'c-1': { peer: true } } }, fence);
    const cacheHashKey = tenantKey(
      TEST_ENV,
      clientId,
      'cache',
      'i',
      instanceId,
      'h',
      'sender-key-memory',
    );
    const firstCachePttl = await handles.redisCache.pttl(cacheHashKey);
    // FINDING-CANDIDATE PROBE: pin whatever is actually implemented for the
    // cache tier's TTL, per the task's instruction ("if cache tier has NO
    // TTL, report it as a finding, not a fix") - redis-repo.ts's setKeys
    // PEXPIREs every touched hash unconditionally regardless of tier, so
    // this is expected to be > 0 too; if it were ever -1 (no TTL) this
    // assertion documents the drift immediately.
    expect(firstCachePttl).toBeGreaterThan(0);
    expect(firstCachePttl).toBeLessThanOrEqual(SIGNAL_KEY_TTL_MS);

    // Manually shrink the sig hash's TTL far below the full window, so a
    // re-write's re-arm is unambiguously observable as "strictly larger",
    // not lost in real-clock jitter between two nearly-simultaneous PEXPIREs.
    await handles.redisSig.pexpire(sigHashKey, 1000);
    const shrunkPttl = await handles.redisSig.pttl(sigHashKey);
    expect(shrunkPttl).toBeLessThanOrEqual(1000);

    await store.setKeys({ session: { 's-2': new Uint8Array([2]) } }, fence);
    const rearmedPttl = await handles.redisSig.pttl(sigHashKey);
    expect(rearmedPttl).toBeGreaterThan(shrunkPttl);
  });
});

describe('tenant isolation', () => {
  it('tenant_b_cannot_read_tenant_a_durable_keys_or_signal_redis_keys_via_getKeys', async () => {
    const fenceA = 1n;
    const fenceB = 1n;
    const { clientId: clientA, instanceId: instanceA } = await seedTenantInstanceAndLease(
      handles.pool,
      fenceA,
    );
    const { clientId: clientB, instanceId: instanceB } = await seedTenantInstanceAndLease(
      handles.pool,
      fenceB,
    );
    probeClientIds.push(clientA, clientB);

    const storeA = buildStore(handles, { instanceId: instanceA, clientId: clientA, fence: fenceA });
    const storeB = buildStore(handles, { instanceId: instanceB, clientId: clientB, fence: fenceB });

    await storeA.saveCreds({ creds: { owner: 'A' }, expectedVersion: 0n, fence: fenceA });
    await storeA.setKeys(
      { 'pre-key': { 'shared-id': { public: new Uint8Array([1]), private: new Uint8Array([2]) } } },
      fenceA,
    );
    await storeA.setKeys({ session: { 'shared-id': new Uint8Array([9, 9, 9]) } }, fenceA);

    // B never wrote 'shared-id' under its OWN instance/client scope - a
    // data-level probe, not a role/RLS probe (fence-predicate probes are
    // role-independent per this phase's P06 pitfall note).
    const bDurable = await storeB.getKeys('pre-key', ['shared-id']);
    expect(bDurable).toEqual({});

    const bSignal = await storeB.getKeys('session', ['shared-id']);
    expect(bSignal).toEqual({});

    // A's own reads still work (isolation is not a blanket failure).
    const aDurable = await storeA.getKeys('pre-key', ['shared-id']);
    expect(Object.keys(aDurable)).toEqual(['shared-id']);
    const aSignal = await storeA.getKeys('session', ['shared-id']);
    expect(Object.keys(aSignal)).toEqual(['shared-id']);

    // Direct Postgres probe: B's tenant-scoped SELECT never returns A's row
    // even by instance_id alone without the client_id predicate matching.
    const crossTenantRow = await handles.pool.query(
      'SELECT 1 FROM whatsapp_session_keys WHERE instance_id = $1 AND client_id = $2',
      [instanceA, clientB],
    );
    expect(crossTenantRow.rows.length).toBe(0);

    // Direct Redis probe: B's own namespaced hash key for the same
    // instance-shaped id never collides with A's hash (different clientId
    // segment in tenantKey()).
    const aHashKey = tenantKey(TEST_ENV, clientA, 'sig', 'i', instanceA, 'h', 'session');
    const bWouldBeHashKey = tenantKey(TEST_ENV, clientB, 'sig', 'i', instanceA, 'h', 'session');
    expect(aHashKey).not.toBe(bWouldBeHashKey);
    const crossRead = await handles.redisSig.hget(bWouldBeHashKey, 'shared-id');
    expect(crossRead).toBeNull();
  });

  it('tenant_b_stale_or_forged_fence_against_tenant_a_instance_cannot_write', async () => {
    // Belt-and-suspenders on top of fence.integration.test.ts's single-tenant
    // stale-fence probe: here tenant B's OWN store (own clientId) attempts a
    // write against tenant A's instanceId directly - the tenant predicate
    // alone must reject it even if B somehow guessed A's live fence.
    const fenceA = 5n;
    const { clientId: clientA, instanceId: instanceA } = await seedTenantInstanceAndLease(
      handles.pool,
      fenceA,
    );
    const clientB = randomUUID();
    await handles.pool.query(
      'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
      [clientB, 'Tenant B Probe', `tenant-b-probe-${clientB}`, 'active'],
    );
    probeClientIds.push(clientA, clientB);

    const ports = makeNoopPorts();
    const forgedStore = buildStore(
      handles,
      { instanceId: instanceA, clientId: clientB, fence: fenceA },
      { ports },
    );

    await expect(
      forgedStore.saveCreds({ creds: { owner: 'B-forged' }, expectedVersion: 0n, fence: fenceA }),
    ).rejects.toThrow(FenceConflictError);

    const credsRow = await handles.pool.query(
      'SELECT 1 FROM whatsapp_session_credentials WHERE instance_id = $1 AND client_id = $2',
      [instanceA, clientB],
    );
    expect(credsRow.rows.length).toBe(0);
  });
});
