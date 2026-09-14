import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  PROBE_WORKER_ID,
  seedTenantInstanceAndLease,
  type StoreTestHandles,
} from './__tests__/store-fixtures.js';
import { classifyWriteMiss, saveCreds } from './pg-repo.js';
import type { SealedBlob } from '@wp/server-kit/crypto';

/**
 * edge-cases.integration.test.ts (E3 hardening pass) - real-Postgres/real-
 * Redis edge cases the mandatory suite + other integration files do not pin:
 * exact fence-boundary semantics and `classifyWriteMiss` races (lease row
 * deleted between the write and the classify re-read). Large/empty batches,
 * Redis PTTL re-arming, and the two-tenant probe live in the sibling file
 * `edge-cases-more.integration.test.ts` (split purely to stay under the
 * repo's `max-lines` guard).
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

function makeBlob(tag: string): SealedBlob {
  return {
    ciphertext: Buffer.from(`ct-${tag}`),
    iv: Buffer.from('123456789012'),
    auth_tag: Buffer.from('1234567890123456'),
    dek_wrapped: Buffer.from(`dw-${tag}`),
    dek_iv: Buffer.from('123456789012'),
    dek_tag: Buffer.from('1234567890123456'),
    kek_id: 'kek-test-1',
    enc_version: 1,
  };
}

describe('boundary fences', () => {
  it('write_at_fence_exactly_equal_to_lease_fence_succeeds', async () => {
    const fence = 42n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const result = await saveCreds(handles.pool as never, {
      instanceId,
      clientId,
      blob: makeBlob('exact'),
      sessionEpoch: 0,
      expectedVersion: 0n,
      fence,
      workerId: PROBE_WORKER_ID,
    });
    expect(result?.credVersion).toBe(1n);
  });

  it('write_at_fence_one_higher_than_the_lease_fence_does_not_succeed', async () => {
    // A caller claiming a fence HIGHER than the live lease fence (never
    // legitimately minted yet) must not be treated as authoritative - the
    // lease-fence EXISTS subquery requires EQUALITY (`ls.current_fence =
    // $fence`), so a future/higher fence is just as much a non-match as a
    // stale/lower one.
    const liveFence = 10n;
    const futureFence = liveFence + 1n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, liveFence);
    probeClientIds.push(clientId);

    const result = await saveCreds(handles.pool as never, {
      instanceId,
      clientId,
      blob: makeBlob('future'),
      sessionEpoch: 0,
      expectedVersion: 0n,
      fence: futureFence,
      workerId: PROBE_WORKER_ID,
    });
    expect(result).toBeNull();

    const missClass = await classifyWriteMiss(handles.pool as never, {
      instanceId,
      clientId,
      expectedVersion: 0n,
      fence: futureFence,
      workerId: PROBE_WORKER_ID,
    });
    expect(missClass).toBe('fence_conflict');
  });

  it('fence_zero_is_rejected_when_the_live_lease_fence_is_nonzero', async () => {
    const liveFence = 3n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, liveFence);
    probeClientIds.push(clientId);

    const result = await saveCreds(handles.pool as never, {
      instanceId,
      clientId,
      blob: makeBlob('zero-fence'),
      sessionEpoch: 0,
      expectedVersion: 0n,
      fence: 0n,
      workerId: PROBE_WORKER_ID,
    });
    expect(result).toBeNull();
  });

  it('negative_fence_is_rejected_never_matches_a_real_lease', async () => {
    const liveFence = 3n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, liveFence);
    probeClientIds.push(clientId);

    const result = await saveCreds(handles.pool as never, {
      instanceId,
      clientId,
      blob: makeBlob('negative-fence'),
      sessionEpoch: 0,
      expectedVersion: 0n,
      fence: -1n,
      workerId: PROBE_WORKER_ID,
    });
    expect(result).toBeNull();

    const missClass = await classifyWriteMiss(handles.pool as never, {
      instanceId,
      clientId,
      expectedVersion: 0n,
      fence: -1n,
      workerId: PROBE_WORKER_ID,
    });
    expect(missClass).toBe('fence_conflict');
  });
});

describe('classifyWriteMiss races', () => {
  it('lease_row_deleted_between_write_and_classify_is_reported_as_fence_conflict', async () => {
    const fence = 6n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    // Simulate the lease being torn down (e.g. a reaper/takeover) AFTER the
    // caller captured its fence but BEFORE its write landed.
    await handles.pool.query('DELETE FROM instance_lease_state WHERE instance_id = $1', [
      instanceId,
    ]);

    const result = await saveCreds(handles.pool as never, {
      instanceId,
      clientId,
      blob: makeBlob('lease-gone'),
      sessionEpoch: 0,
      expectedVersion: 0n,
      fence,
      workerId: PROBE_WORKER_ID,
    });
    expect(result).toBeNull();

    const missClass = await classifyWriteMiss(handles.pool as never, {
      instanceId,
      clientId,
      expectedVersion: 0n,
      fence,
      workerId: PROBE_WORKER_ID,
    });
    // No lease row at all => fence_conflict, per classifyWriteMiss's own
    // documented LEFT JOIN semantics (NULL current_fence treated as mismatch).
    expect(missClass).toBe('fence_conflict');
  });

  it('expectedVersion_ahead_of_stored_with_a_still_current_fence_is_version_conflict', async () => {
    const fence = 8n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    await saveCreds(handles.pool as never, {
      instanceId,
      clientId,
      blob: makeBlob('base'),
      sessionEpoch: 0,
      expectedVersion: 0n,
      fence,
      workerId: PROBE_WORKER_ID,
    });

    const result = await saveCreds(handles.pool as never, {
      instanceId,
      clientId,
      blob: makeBlob('ahead'),
      sessionEpoch: 0,
      expectedVersion: 999n, // way ahead of the real cred_version=1
      fence,
      workerId: PROBE_WORKER_ID,
    });
    expect(result).toBeNull();

    const missClass = await classifyWriteMiss(handles.pool as never, {
      instanceId,
      clientId,
      expectedVersion: 999n,
      fence,
      workerId: PROBE_WORKER_ID,
    });
    expect(missClass).toBe('version_conflict');
  });
});
