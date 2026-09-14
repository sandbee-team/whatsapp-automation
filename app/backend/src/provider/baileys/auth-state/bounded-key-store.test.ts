import { describe, expect, it, vi } from 'vitest';
import { makeBoundedSignalKeyStore } from './bounded-key-store.js';
import type { EncryptedAuthStore } from './types.js';
import type { SignalMetricsHandles } from '../../../platform/metrics/signal-metrics.js';

/**
 * bounded-key-store.test.ts (P07 Unit U5, step 8) - pure unit tests (fake
 * clock, no sleeps, no real store) for `makeBoundedSignalKeyStore`'s LRU+TTL
 * cache behavior in FRONT of an injected `EncryptedAuthStore` stub. Metrics
 * are a plain `vi.fn()` stub (same style as `lease-manager.test.ts`'s
 * `incrementTakeovers` spies) - never a real `prom-client` registry, so
 * assertions are on call counts, not label internals.
 */

function makeMetricsStub(): SignalMetricsHandles {
  return {
    hitTotal: undefined as unknown as SignalMetricsHandles['hitTotal'],
    missTotal: undefined as unknown as SignalMetricsHandles['missTotal'],
    evictedTotal: undefined as unknown as SignalMetricsHandles['evictedTotal'],
    decryptFailureTotal: undefined as unknown as SignalMetricsHandles['decryptFailureTotal'],
    redisSigFieldEvictedTotal:
      undefined as unknown as SignalMetricsHandles['redisSigFieldEvictedTotal'],
    redisSigFieldCapReachedTotal:
      undefined as unknown as SignalMetricsHandles['redisSigFieldCapReachedTotal'],
    incrementHit: vi.fn(),
    incrementMiss: vi.fn(),
    incrementEvicted: vi.fn(),
    incrementDecryptFailure: vi.fn(),
    incrementRedisSigFieldEvicted: vi.fn(),
    incrementRedisSigFieldCapReached: vi.fn(),
  };
}

function makeStoreStub(): {
  store: Pick<EncryptedAuthStore, 'getKeys' | 'setKeys'>;
  getKeysMock: ReturnType<typeof vi.fn>;
  setKeysMock: ReturnType<typeof vi.fn>;
  backing: Map<string, unknown>;
} {
  const backing = new Map<string, unknown>();

  const getKeysMock = vi.fn(async (type: string, ids: string[]) => {
    const result: Record<string, unknown> = {};
    for (const id of ids) {
      const key = `${type}:${id}`;
      if (backing.has(key)) {
        result[id] = backing.get(key);
      }
    }
    return result;
  });

  const setKeysMock = vi.fn(async (data: Record<string, Record<string, unknown> | null>) => {
    for (const [type, byId] of Object.entries(data)) {
      if (!byId) continue;
      for (const [id, value] of Object.entries(byId)) {
        const key = `${type}:${id}`;
        if (value === null || value === undefined) {
          backing.delete(key);
        } else {
          backing.set(key, value);
        }
      }
    }
  });

  return {
    store: {
      getKeys: getKeysMock as unknown as EncryptedAuthStore['getKeys'],
      setKeys: setKeysMock as unknown as EncryptedAuthStore['setKeys'],
    },
    getKeysMock,
    setKeysMock,
    backing,
  };
}

describe('makeBoundedSignalKeyStore', () => {
  it('bounded_key_store_writes_through_on_eviction', async () => {
    const metrics = makeMetricsStub();
    const { store, getKeysMock } = makeStoreStub();

    const keyStore = makeBoundedSignalKeyStore({
      store: store as EncryptedAuthStore,
      maxEntries: 2,
      now: () => 0,
      metrics,
    });

    await keyStore.set({ session: { a: new Uint8Array([1]), b: new Uint8Array([2]) } });
    // Insert a third entry beyond maxEntries=2 - evicts the LRU entry ('a').
    await keyStore.set({ session: { c: new Uint8Array([3]) } });

    expect(metrics.incrementEvicted).toHaveBeenCalledTimes(1);

    // The evicted entry ('a') was already written through, so it is
    // readable again from the store - a fresh get() falls through (miss)
    // and repopulates the cache from the backing store.
    getKeysMock.mockClear();
    const result = await keyStore.get('session', ['a']);
    expect(result['a']).toEqual(new Uint8Array([1]));
    expect(getKeysMock).toHaveBeenCalledTimes(1);
    expect(metrics.incrementMiss).toHaveBeenCalled();
  });

  it('null_value_in_set_deletes_the_key', async () => {
    const metrics = makeMetricsStub();
    const { store, setKeysMock } = makeStoreStub();

    const keyStore = makeBoundedSignalKeyStore({
      store: store as EncryptedAuthStore,
      now: () => 0,
      metrics,
    });

    await keyStore.set({ session: { a: new Uint8Array([1]) } });
    const before = await keyStore.get('session', ['a']);
    expect(before['a']).toEqual(new Uint8Array([1]));

    await keyStore.set({ session: { a: null } });

    // The store's own setKeys saw a null value -> a delete, not "store null".
    expect(setKeysMock).toHaveBeenLastCalledWith({ session: { a: null } });

    const after = await keyStore.get('session', ['a']);
    expect(after['a']).toBeUndefined();
    expect('a' in after).toBe(false);
  });

  it('tracked_participant_devices_cannot_exceed_the_cap', async () => {
    const metrics = makeMetricsStub();
    const { store } = makeStoreStub();

    const keyStore = makeBoundedSignalKeyStore({
      store: store as EncryptedAuthStore,
      maxEntries: 2000,
      now: () => 0,
      metrics,
    });

    for (let i = 0; i < 2000; i += 1) {
      await keyStore.set({ session: { [`k${String(i)}`]: new Uint8Array([i % 256]) } });
    }
    expect(metrics.incrementEvicted).not.toHaveBeenCalled();

    // The 2001st entry evicts LRU (k0) instead of growing past the cap.
    await keyStore.set({ session: { k2000: new Uint8Array([1]) } });
    expect(metrics.incrementEvicted).toHaveBeenCalledTimes(1);

    // k0 was evicted from the cache but was written through, so the store
    // stub itself still holds it (readable again) - the cap bounds the
    // in-memory cache size, not data loss.
    const missing = await keyStore.get('session', ['k0']);
    expect(missing['k0']).toEqual(new Uint8Array([0]));
  });
});
