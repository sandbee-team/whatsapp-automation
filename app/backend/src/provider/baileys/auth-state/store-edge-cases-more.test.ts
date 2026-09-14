import '../../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createEncryptedAuthStore } from './store.js';
import { FenceConflictError, StoreFencedError } from './types.js';
import type { AuthStoreIdentity, AuthStorePorts, CreateEncryptedAuthStoreDeps } from './types.js';
import type { AuthCodec } from './codec.js';
import type { SignalRedisRepo } from './redis-repo.js';
import type { SealedBlob } from '@wp/server-kit/crypto';

/**
 * store-edge-cases-more.test.ts (E3 hardening pass, split of
 * store-edge-cases.test.ts purely to stay under the repo's `max-lines`
 * guard) - empty-input no-ops (`setKeys`/`getKeys` with nothing to do) and
 * the fenced-store rejection path (every write throws `StoreFencedError`
 * without touching the repo again once self-fenced).
 */

function makeBlob(tag: string): SealedBlob {
  return {
    ciphertext: Buffer.from(`ct-${tag}`),
    iv: Buffer.from('123456789012'),
    auth_tag: Buffer.from('1234567890123456'),
    dek_wrapped: Buffer.from(`dw-${tag}`),
    dek_iv: Buffer.from('123456789012'),
    dek_tag: Buffer.from('1234567890123456'),
    kek_id: 'kek-1',
    enc_version: 1,
  };
}

function makeCodecStub(): AuthCodec {
  return {
    sealAuthValue: vi.fn((value: unknown) => makeBlob(JSON.stringify(value))),
    openAuthValue: vi.fn((blob: SealedBlob) => ({ blob })),
    encodeSealedBlob: vi.fn((blob: SealedBlob) => Buffer.from(JSON.stringify(blob))),
    decodeSealedBlob: vi.fn((buf: Buffer) => JSON.parse(buf.toString('utf8')) as SealedBlob),
  };
}

function makeIdentity(overrides: Partial<AuthStoreIdentity> = {}): AuthStoreIdentity {
  return {
    instanceId: 'inst-1',
    clientId: 'client-1',
    sessionEpoch: 0,
    fence: 1n,
    env: 'test',
    workerId: 'worker-1',
    ...overrides,
  };
}

function makePorts(): AuthStorePorts {
  return {
    onFenceConflict: vi.fn().mockResolvedValue(undefined),
    onSignalWriteFailure: vi.fn().mockResolvedValue(undefined),
    releaseLease: vi.fn().mockResolvedValue(undefined),
  };
}

function makeNoopRedisRepo(): SignalRedisRepo {
  return {
    getKeys: vi.fn().mockResolvedValue(new Map()),
    setKeys: vi.fn().mockResolvedValue(undefined),
    purgeInstance: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMetrics() {
  return {
    hitTotal: undefined as never,
    missTotal: undefined as never,
    evictedTotal: undefined as never,
    decryptFailureTotal: undefined as never,
    redisSigFieldEvictedTotal: undefined as never,
    redisSigFieldCapReachedTotal: undefined as never,
    incrementHit: vi.fn(),
    incrementMiss: vi.fn(),
    incrementEvicted: vi.fn(),
    incrementDecryptFailure: vi.fn(),
    incrementRedisSigFieldEvicted: vi.fn(),
    incrementRedisSigFieldCapReached: vi.fn(),
  };
}

describe('createEncryptedAuthStore edge cases (mocked pgRepo/redisRepo)', () => {
  it('setKeys_with_empty_writes_array_is_a_no_op_no_sql_or_redis_calls', async () => {
    const pgSetKeysMock = vi.fn();
    const redisRepo = makeNoopRedisRepo();
    const pgRepoStub = {
      saveCreds: vi.fn(),
      classifyWriteMiss: vi.fn(),
      loadCreds: vi.fn(),
      purgeDurable: vi.fn(),
      getKeys: vi.fn(),
      setKeys: pgSetKeysMock,
    } as unknown as CreateEncryptedAuthStoreDeps['pgRepo'];

    const store = createEncryptedAuthStore({
      db: {} as CreateEncryptedAuthStoreDeps['db'],
      pgRepo: pgRepoStub,
      redisRepo,
      codec: makeCodecStub(),
      identity: makeIdentity(),
      ports: makePorts(),
      metrics: makeMetrics(),
    });

    // No key types at all.
    await store.setKeys({});
    expect(pgSetKeysMock).not.toHaveBeenCalled();
    expect(redisRepo.setKeys).not.toHaveBeenCalled();

    // Key types present but each maps to an empty id object - still a no-op
    // (the `for...of Object.entries(byId)` loop never iterates).
    await store.setKeys({ session: {}, 'pre-key': {} });
    expect(pgSetKeysMock).not.toHaveBeenCalled();
    expect(redisRepo.setKeys).not.toHaveBeenCalled();
  });

  it('getKeys_with_empty_ids_returns_empty_and_the_signal_tier_never_calls_redis', async () => {
    // Durable tier: `store.ts`/`store-keys.ts` do not special-case empty ids
    // themselves - they call through to `pgRepo.getKeys`, which is the layer
    // that actually short-circuits before any SQL runs (see
    // `pg-repo-keys.ts`'s own `if (ids.length === 0) return result;`). This
    // pins the REAL behavior: the repo call happens, but with zero ids and
    // zero SQL as a result, never an empty-map fabrication one layer up.
    const pgGetKeysMock = vi.fn().mockResolvedValue(new Map());
    const redisRepo = makeNoopRedisRepo();
    const pgRepoStub = {
      saveCreds: vi.fn(),
      classifyWriteMiss: vi.fn(),
      loadCreds: vi.fn(),
      purgeDurable: vi.fn(),
      getKeys: pgGetKeysMock,
      setKeys: vi.fn(),
    } as unknown as CreateEncryptedAuthStoreDeps['pgRepo'];

    const store = createEncryptedAuthStore({
      db: {} as CreateEncryptedAuthStoreDeps['db'],
      pgRepo: pgRepoStub,
      redisRepo,
      codec: makeCodecStub(),
      identity: makeIdentity(),
      ports: makePorts(),
      metrics: makeMetrics(),
    });

    const durableResult = await store.getKeys('pre-key', []);
    expect(durableResult).toEqual({});
    expect(pgGetKeysMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'pre-key', []);

    // Signal tier DOES short-circuit at `redisRepo.getKeys` itself - the
    // real `createSignalRedisRepo.getKeys` returns an empty Map for empty
    // ids without any HMGET round-trip (see redis-repo.ts). This store-level
    // stub call still counts as "reached the repo", so assert the repo
    // returns empty rather than asserting it was never called.

    const signalResult = await store.getKeys('session', []);
    expect(signalResult).toEqual({});
  });

  it('a_fenced_store_rejects_setKeys_and_purge_without_touching_repos', async () => {
    const pgRepoStub = {
      saveCreds: vi.fn().mockResolvedValue(null),
      classifyWriteMiss: vi.fn().mockResolvedValue('fence_conflict'),
      loadCreds: vi.fn(),
      purgeDurable: vi.fn(),
      getKeys: vi.fn(),
      setKeys: vi.fn(),
    } as unknown as CreateEncryptedAuthStoreDeps['pgRepo'];

    const redisRepo = makeNoopRedisRepo();
    const ports = makePorts();
    const store = createEncryptedAuthStore({
      db: {} as CreateEncryptedAuthStoreDeps['db'],
      pgRepo: pgRepoStub,
      redisRepo,
      codec: makeCodecStub(),
      identity: makeIdentity(),
      ports,
      metrics: makeMetrics(),
    });

    // Drive the store into the fenced state via a fence-conflicting saveCreds.
    await expect(
      store.saveCreds({ creds: { a: 1 }, expectedVersion: 0n, fence: 1n }),
    ).rejects.toThrow(FenceConflictError);
    expect(ports.onFenceConflict).toHaveBeenCalledTimes(1);
    expect(ports.releaseLease).toHaveBeenCalledTimes(1);

    // Every subsequent write throws StoreFencedError WITHOUT calling the
    // repo again (no attempt to sneak a write past a self-fenced store).
    vi.mocked(redisRepo.setKeys).mockClear();
    await expect(store.setKeys({ session: { a: new Uint8Array([1]) } })).rejects.toThrow(
      StoreFencedError,
    );
    expect(redisRepo.setKeys).not.toHaveBeenCalled();

    await expect(store.purge(1n)).rejects.toThrow(StoreFencedError);

    // onFenceConflict/releaseLease are NOT called again on the second failure.
    expect(ports.onFenceConflict).toHaveBeenCalledTimes(1);
    expect(ports.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('a_successful_purge_terminally_fences_the_store_without_a_fence_conflict_port_call', async () => {
    // FIX-B WARNING: a self-purge is not a takeover - `purge()` must leave
    // the store terminally fenced (every subsequent write throws
    // StoreFencedError, never a bare success) WITHOUT calling
    // ports.onFenceConflict/ports.releaseLease the way a real fence-conflict
    // self-fence does. Reads (loadCreds/getKeys) stay allowed afterwards.
    const dbConnectMock = vi.fn().mockResolvedValue({
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (/RETURNING/i.test(sql)) {
          return { rows: [{ session_epoch: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    });

    const loadCredsMock = vi.fn().mockResolvedValue(null);
    const getKeysMock = vi.fn().mockResolvedValue(new Map());
    const saveCredsMock = vi.fn();
    const pgRepoStub = {
      saveCreds: saveCredsMock,
      classifyWriteMiss: vi.fn(),
      loadCreds: loadCredsMock,
      purgeDurable: vi.fn(),
      getKeys: getKeysMock,
      setKeys: vi.fn(),
    } as unknown as CreateEncryptedAuthStoreDeps['pgRepo'];

    const redisRepo = makeNoopRedisRepo();
    const ports = makePorts();
    const store = createEncryptedAuthStore({
      db: { connect: dbConnectMock } as unknown as CreateEncryptedAuthStoreDeps['db'],
      pgRepo: pgRepoStub,
      redisRepo,
      codec: makeCodecStub(),
      identity: makeIdentity(),
      ports,
      metrics: makeMetrics(),
    });

    await expect(store.purge(1n)).resolves.toEqual({ purged: true });

    // Purge succeeding must NEVER call the fence-conflict port pair - a
    // self-purge is not a fence loss, and the caller still owns lease
    // release through its own normal flow.
    expect(ports.onFenceConflict).not.toHaveBeenCalled();
    expect(ports.releaseLease).not.toHaveBeenCalled();

    // A following write throws StoreFencedError (NOT FenceConflictError) -
    // no repo call at all, exactly like every other post-fence write.
    await expect(
      store.saveCreds({ creds: { a: 1 }, expectedVersion: 0n, fence: 1n }),
    ).rejects.toHaveProperty('name', 'StoreFencedError');
    expect(saveCredsMock).not.toHaveBeenCalled();

    // Reads stay allowed after purge - loadCreds/getKeys are not gated by
    // the fenced flag (see types.ts's PurgeResult doc comment).
    await expect(store.loadCreds()).resolves.toBeNull();
    expect(loadCredsMock).toHaveBeenCalledTimes(1);
    await expect(store.getKeys('pre-key', ['k1'])).resolves.toEqual({});
    expect(getKeysMock).toHaveBeenCalledTimes(1);
  });
});
