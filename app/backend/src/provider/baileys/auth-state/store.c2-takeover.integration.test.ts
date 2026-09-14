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
import { FenceConflictError, StoreFencedError } from './types.js';

/**
 * store.c2-takeover.integration.test.ts (P07 close step C2) - the "two
 * concurrent stores for one instance" (real takeover) category, split out of
 * `store.c2.integration.test.ts` purely to stay under the repo's `max-lines`
 * guard. See that file's header for the full C2 category map.
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

/** Bumps `instance_lease_state.current_fence` directly - mints fence F+1 for a "takeover" without needing real Redis lease timing. */
async function mintNextFence(
  pool: StoreTestHandles['pool'],
  instanceId: string,
  clientId: string,
  newFence: bigint,
): Promise<void> {
  await pool.query(
    'UPDATE instance_lease_state SET current_fence = $1, lease_seen_at = now() WHERE instance_id = $2 AND client_id = $3',
    [newFence.toString(), instanceId, clientId],
  );
}

describe('C2: two concurrent stores for one instance (real takeover)', () => {
  it('store_a_writes_after_b_mints_fail_closed_a_self_fences_once_and_final_state_is_exactly_bs_writes', async () => {
    const fenceA = 20n;
    const fenceB = fenceA + 1n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fenceA);
    probeClientIds.push(clientId);

    const portsA = makeNoopPorts();
    const storeA = buildStore(handles, { instanceId, clientId, fence: fenceA }, { ports: portsA });

    // A writes first, legitimately, while it is still the live fence.
    await storeA.saveCreds({ creds: { owner: 'A', seq: 1 }, expectedVersion: 0n, fence: fenceA });
    await storeA.setKeys({ session: { 's-a': new Uint8Array([1]) } }, fenceA);

    // B "takes over": mint fence F+1 directly on instance_lease_state (the
    // real takeover shape - a fresh LeaseManager.acquire would do the same
    // UPDATE under the hood).
    await mintNextFence(handles.pool, instanceId, clientId, fenceB);
    const portsB = makeNoopPorts();
    const storeB = buildStore(handles, { instanceId, clientId, fence: fenceB }, { ports: portsB });

    await storeB.saveCreds({ creds: { owner: 'B', seq: 1 }, expectedVersion: 1n, fence: fenceB });
    await storeB.setKeys({ session: { 's-b': new Uint8Array([2]) } }, fenceB);

    // Interleave: every subsequent A write after B's mint fails closed.
    await expect(
      storeA.saveCreds({ creds: { owner: 'A', seq: 2 }, expectedVersion: 1n, fence: fenceA }),
    ).rejects.toThrow(FenceConflictError);
    await expect(
      storeA.setKeys({ session: { 's-a2': new Uint8Array([3]) } }, fenceA),
    ).rejects.toThrow(StoreFencedError);

    // A self-fenced exactly once (the FIRST failing write triggers
    // selfFence; the store then throws StoreFencedError on any further
    // call without re-invoking the port).
    expect(portsA.onFenceConflict).toHaveBeenCalledTimes(1);
    expect(portsA.releaseLease).toHaveBeenCalledTimes(1);

    // B's further writes all land normally.
    await storeB.saveCreds({ creds: { owner: 'B', seq: 2 }, expectedVersion: 2n, fence: fenceB });
    expect(portsB.onFenceConflict).not.toHaveBeenCalled();
    expect(portsB.releaseLease).not.toHaveBeenCalled();

    // Final PG state is exactly B's writes (byte-check via loadCreds + raw row).
    const finalCreds = await storeB.loadCreds();
    expect(finalCreds).toEqual({ owner: 'B', seq: 2 });

    const credRow = await handles.pool.query<{ owner_fence: string; cred_version: string }>(
      'SELECT owner_fence, cred_version FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    expect(credRow.rows[0]?.owner_fence).toBe(fenceB.toString());
    expect(credRow.rows[0]?.cred_version).toBe('3'); // A's 1 save + B's 2 saves

    // Final Redis state: B's key present, A's post-takeover attempt never landed.
    const sigHashKey = tenantKey(TEST_ENV, clientId, 'sig', 'i', instanceId, 'h', 'session');
    const finalHash = await handles.redisSig.hgetall(sigHashKey);
    expect(Object.keys(finalHash).sort()).toEqual(['s-a', 's-b']);
  });
});
