import { describe, expect, it, vi } from 'vitest';
import { makeBoundedSignalKeyStore } from './bounded-key-store.js';
import type { EncryptedAuthStore } from './types.js';
import type { SignalMetricsHandles } from '../../../platform/metrics/signal-metrics.js';

/**
 * bounded-key-store-edge-cases.test.ts (E3 hardening pass) - fake-clock
 * (injected `now`), no-sleep coverage of the LRU+TTL semantics
 * `bounded-key-store.test.ts` does not pin: the exact TTL boundary, genuine
 * TOUCH-order LRU (a re-read of the oldest entry keeps it alive over a
 * never-re-read newer entry - insertion order alone would evict the wrong
 * key), no resurrection of a null-deleted key from a stale cache entry, and
 * `clear()` forcing a real store read (miss counter increments).
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

describe('makeBoundedSignalKeyStore edge cases', () => {
  it('entry_at_exactly_ttlMs_age_is_treated_as_expired_boundary_is_exclusive', async () => {
    const metrics = makeMetricsStub();
    const { store, getKeysMock } = makeStoreStub();
    let clock = 0;

    const keyStore = makeBoundedSignalKeyStore({
      store: store as EncryptedAuthStore,
      ttlMs: 1000,
      now: () => clock,
      metrics,
    });

    await keyStore.set({ session: { a: new Uint8Array([1]) } });

    // Just under the TTL boundary: still fresh, cache hit.
    clock = 999;
    getKeysMock.mockClear();
    const stillFresh = await keyStore.get('session', ['a']);
    expect(stillFresh['a']).toEqual(new Uint8Array([1]));
    expect(getKeysMock).not.toHaveBeenCalled();

    // Reset the entry's insertedAtMs back to 0 by re-touching is wrong for
    // this probe - instead exercise a FRESH key at t=0, then advance the
    // clock to EXACTLY ttlMs (isFresh uses strict `<`, so `now() -
    // insertedAtMs < ttlMs` is false at exactly ttlMs - this pins that the
    // boundary itself is EXPIRED, not fresh).
    clock = 0;
    await keyStore.set({ session: { b: new Uint8Array([2]) } });
    clock = 1000; // exactly ttlMs later
    getKeysMock.mockClear();
    vi.mocked(metrics.incrementMiss).mockClear();
    const atBoundary = await keyStore.get('session', ['b']);
    expect(atBoundary['b']).toEqual(new Uint8Array([2])); // falls through to store, still correct value
    expect(getKeysMock).toHaveBeenCalledTimes(1); // but it was a MISS, not a cache hit
    expect(metrics.incrementMiss).toHaveBeenCalled();
  });

  it('eviction_order_is_genuine_touch_order_lru_not_insertion_order', async () => {
    const metrics = makeMetricsStub();
    const { store, getKeysMock } = makeStoreStub();

    const keyStore = makeBoundedSignalKeyStore({
      store: store as EncryptedAuthStore,
      maxEntries: 2,
      now: () => 0,
      metrics,
    });

    // Insert 'a' then 'b' (insertion order: a, b).
    await keyStore.set({ session: { a: new Uint8Array([1]) } });
    await keyStore.set({ session: { b: new Uint8Array([2]) } });

    // Re-read 'a' - this must move 'a' to the MRU end, so 'b' becomes the
    // LRU victim on the next insert (pure insertion order would evict 'a').
    getKeysMock.mockClear();
    await keyStore.get('session', ['a']);
    expect(getKeysMock).not.toHaveBeenCalled(); // cache hit, no store fall-through

    // Insert a third entry beyond maxEntries=2 - must evict 'b' (LRU by
    // touch order), NOT 'a' (which would be the insertion-order victim).
    await keyStore.set({ session: { c: new Uint8Array([3]) } });
    expect(metrics.incrementEvicted).toHaveBeenCalledTimes(1);

    getKeysMock.mockClear();
    const stillCached = await keyStore.get('session', ['a']);
    expect(stillCached['a']).toEqual(new Uint8Array([1]));
    expect(getKeysMock).not.toHaveBeenCalled(); // 'a' survived - still a cache hit

    getKeysMock.mockClear();
    const evicted = await keyStore.get('session', ['b']);
    expect(evicted['b']).toEqual(new Uint8Array([2])); // correct value, but...
    expect(getKeysMock).toHaveBeenCalledTimes(1); // ...it was evicted, so this was a miss
  });

  it('a_null_deleted_key_does_not_resurrect_from_a_stale_cache_entry_after_eviction_pressure', async () => {
    const metrics = makeMetricsStub();
    const { store, getKeysMock, backing } = makeStoreStub();

    const keyStore = makeBoundedSignalKeyStore({
      store: store as EncryptedAuthStore,
      maxEntries: 1,
      now: () => 0,
      metrics,
    });

    await keyStore.set({ session: { a: new Uint8Array([1]) } });
    // Null-delete 'a' through the SAME keyStore - both the store and the
    // cache entry for 'a' are removed.
    await keyStore.set({ session: { a: null } });
    expect(backing.has('session:a')).toBe(false);

    // Force cache churn that would repopulate an LRU slot from a DIFFERENT
    // key, to prove 'a' isn't somehow still readable via a stale slot.
    await keyStore.set({ session: { z: new Uint8Array([9]) } });

    getKeysMock.mockClear();
    const afterDelete = await keyStore.get('session', ['a']);
    expect(afterDelete['a']).toBeUndefined();
    expect('a' in afterDelete).toBe(false);
    // It genuinely fell through to the store (a real miss), not a resurrected
    // cache hit - and the store confirms 'a' truly is gone.
    expect(getKeysMock).toHaveBeenCalledTimes(1);
  });

  it('clear_forces_the_next_get_to_read_the_store_again_even_for_a_previously_cached_hit', async () => {
    const metrics = makeMetricsStub();
    const { store, getKeysMock } = makeStoreStub();

    const keyStore = makeBoundedSignalKeyStore({
      store: store as EncryptedAuthStore,
      now: () => 0,
      metrics,
    });

    await keyStore.set({ session: { a: new Uint8Array([1]) } });

    // Confirm it is currently a cache hit.
    getKeysMock.mockClear();
    await keyStore.get('session', ['a']);
    expect(getKeysMock).not.toHaveBeenCalled();

    if (!keyStore.clear) {
      throw new Error('expected makeBoundedSignalKeyStore to implement clear()');
    }
    keyStore.clear();

    // clear() only empties the cache - the backing store is untouched, so
    // the value is still correct, but it must have required a genuine
    // re-read (miss) this time.
    getKeysMock.mockClear();
    vi.mocked(metrics.incrementMiss).mockClear();
    const afterClear = await keyStore.get('session', ['a']);
    expect(afterClear['a']).toEqual(new Uint8Array([1]));
    expect(getKeysMock).toHaveBeenCalledTimes(1);
    expect(metrics.incrementMiss).toHaveBeenCalled();
  });
});
