import '../../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createEncryptedAuthStore } from './store.js';
import { CredsSaveExhaustedError } from './types.js';
import type { AuthStoreIdentity, AuthStorePorts, CreateEncryptedAuthStoreDeps } from './types.js';
import type { AuthCodec } from './codec.js';
import type { SignalRedisRepo } from './redis-repo.js';
import type { SealedBlob } from '@wp/server-kit/crypto';

/**
 * store-edge-cases.test.ts (E3 hardening pass) - pure unit tests (mocked
 * `pgRepo`/`redisRepo`/`codec`, no real Postgres/Redis) targeting:
 *
 *  - retry exhaustion: a persistent version conflict (an external writer
 *    bumps `cred_version` between every retry) throws
 *    `CredsSaveExhaustedError` after EXACTLY 3 attempts, never calls a port,
 *    and leaves the promise chain usable for the next `saveCreds`.
 *  - promise-chain integrity: a `saveCreds` that throws does not wedge the
 *    chain for the next caller (exhaustion case AND fence-conflict case).
 *  - the shared chainTail now serialises saveCreds/setKeys/purge together
 *    (FIX-A CRITICAL-1(a)).
 *
 * Empty-input and fenced-store cases live in the sibling file
 * `store-edge-cases-more.test.ts` (split purely to stay under the repo's
 * `max-lines` guard).
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
  it('saveCreds_exhausts_after_exactly_3_attempts_on_persistent_version_conflict_never_calls_ports', async () => {
    let liveCredVersion = 0n;
    // Every call to saveCreds sees a STALE expectedVersion because an
    // "external writer" bumps liveCredVersion right before each attempt -
    // classifyWriteMiss always reports version_conflict (fence still
    // matches), never fence_conflict.
    const saveCredsMock = vi.fn().mockImplementation(async () => {
      liveCredVersion += 1n; // external writer wins the race, every time
      return null; // zero rows: this caller's expectedVersion is now stale
    });
    const classifyWriteMissMock = vi.fn().mockResolvedValue('version_conflict');
    const loadCredsMock = vi.fn().mockImplementation(async () => ({
      blob: makeBlob('reload'),
      credVersion: liveCredVersion,
      sessionEpoch: 0,
    }));

    const pgRepoStub = {
      saveCreds: saveCredsMock,
      classifyWriteMiss: classifyWriteMissMock,
      loadCreds: loadCredsMock,
      purgeDurable: vi.fn(),
      getKeys: vi.fn(),
      setKeys: vi.fn(),
    } as unknown as CreateEncryptedAuthStoreDeps['pgRepo'];

    const ports = makePorts();
    const deps: CreateEncryptedAuthStoreDeps = {
      db: {} as CreateEncryptedAuthStoreDeps['db'],
      pgRepo: pgRepoStub,
      redisRepo: makeNoopRedisRepo(),
      codec: makeCodecStub(),
      identity: makeIdentity(),
      ports,
      metrics: makeMetrics(),
    };

    const store = createEncryptedAuthStore(deps);

    await expect(
      store.saveCreds({ creds: { a: 1 }, expectedVersion: 0n, fence: 1n }),
    ).rejects.toThrow(CredsSaveExhaustedError);

    // Exactly 3 attempts at the actual write (MAX_SAVE_CREDS_RETRIES).
    expect(saveCredsMock).toHaveBeenCalledTimes(3);
    // Ports are never called for exhaustion - this is an ordinary optimistic
    // concurrency exhaustion, never a fence loss.
    expect(ports.onFenceConflict).not.toHaveBeenCalled();
    expect(ports.releaseLease).not.toHaveBeenCalled();

    // The chain is still usable: a subsequent saveCreds that succeeds
    // (classifyWriteMiss never invoked because saveCreds itself succeeds).
    saveCredsMock.mockReset();
    saveCredsMock.mockResolvedValueOnce({ credVersion: 99n });
    await expect(
      store.saveCreds({ creds: { a: 2 }, expectedVersion: 5n, fence: 1n }),
    ).resolves.toEqual({ credVersion: 99n });
    expect(saveCredsMock).toHaveBeenCalledTimes(1);
  });

  it('saveCreds_throw_does_not_wedge_the_chain_next_call_still_runs', async () => {
    const saveCredsMock = vi
      .fn()
      // First call: zero rows every attempt -> exhausts.
      .mockResolvedValue(null);
    const classifyWriteMissMock = vi.fn().mockResolvedValue('version_conflict');
    const loadCredsMock = vi.fn().mockResolvedValue({
      blob: makeBlob('reload'),
      credVersion: 0n,
      sessionEpoch: 0,
    });

    const pgRepoStub = {
      saveCreds: saveCredsMock,
      classifyWriteMiss: classifyWriteMissMock,
      loadCreds: loadCredsMock,
      purgeDurable: vi.fn(),
      getKeys: vi.fn(),
      setKeys: vi.fn(),
    } as unknown as CreateEncryptedAuthStoreDeps['pgRepo'];

    const store = createEncryptedAuthStore({
      db: {} as CreateEncryptedAuthStoreDeps['db'],
      pgRepo: pgRepoStub,
      redisRepo: makeNoopRedisRepo(),
      codec: makeCodecStub(),
      identity: makeIdentity(),
      ports: makePorts(),
      metrics: makeMetrics(),
    });

    // Fire two overlapping saveCreds calls (both destined to fail via
    // exhaustion). The SECOND call's rejection must be its own
    // CredsSaveExhaustedError, not an unrelated wedge/hang, and both must
    // settle (never leave chainTail permanently rejected).
    const first = store.saveCreds({ creds: { a: 1 }, expectedVersion: 0n, fence: 1n });
    const second = store.saveCreds({ creds: { a: 2 }, expectedVersion: 0n, fence: 1n });

    await expect(first).rejects.toThrow(CredsSaveExhaustedError);
    await expect(second).rejects.toThrow(CredsSaveExhaustedError);

    // A THIRD call after both failures still runs (chain not wedged) - make
    // it succeed this time.
    saveCredsMock.mockReset();
    saveCredsMock.mockResolvedValueOnce({ credVersion: 1n });
    await expect(
      store.saveCreds({ creds: { a: 3 }, expectedVersion: 0n, fence: 1n }),
    ).resolves.toEqual({ credVersion: 1n });
  });

  it('purge_mid_chain_IS_now_serialised_behind_saveCreds', async () => {
    // FIX-A CRITICAL-1(a) (was purge_mid_chain_is_not_serialised_behind_
    // saveCreds_pin_current_behavior): store.ts now chains saveCreds,
    // setKeys, AND purge behind the SAME `chainTail` - a slow in-flight
    // saveCreds now BLOCKS a concurrently-issued purge from starting until
    // the saveCreds settles, rather than letting purge run and complete
    // first.
    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });

    const saveCredsMock = vi.fn().mockImplementation(async () => {
      await saveGate;
      return { credVersion: 1n };
    });

    const pgRepoStub = {
      saveCreds: saveCredsMock,
      classifyWriteMiss: vi.fn(),
      loadCreds: vi.fn(),
      purgeDurable: vi.fn(),
      getKeys: vi.fn(),
      setKeys: vi.fn(),
    } as unknown as CreateEncryptedAuthStoreDeps['pgRepo'];

    const dbConnectMock = vi.fn().mockResolvedValue({
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (/RETURNING/i.test(sql)) {
          return { rows: [{ session_epoch: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    });

    const store = createEncryptedAuthStore({
      db: { connect: dbConnectMock } as unknown as CreateEncryptedAuthStoreDeps['db'],
      pgRepo: pgRepoStub,
      redisRepo: makeNoopRedisRepo(),
      codec: makeCodecStub(),
      identity: makeIdentity(),
      ports: makePorts(),
      metrics: makeMetrics(),
    });

    const savePromise = store.saveCreds({ creds: { a: 1 }, expectedVersion: 0n, fence: 1n });
    // purge is queued behind the still-gated saveCreds - it must NOT touch
    // `db.connect()` (and therefore cannot complete) until saveCreds settles.
    const purgePromise = store.purge(1n);

    // Give the microtask queue a turn - if purge were NOT serialised behind
    // saveCreds, `dbConnectMock` would already have been called by now.
    await Promise.resolve();
    await Promise.resolve();
    expect(dbConnectMock).not.toHaveBeenCalled();

    releaseSave?.();
    await expect(savePromise).resolves.toEqual({ credVersion: 1n });
    await expect(purgePromise).resolves.toEqual({ purged: true });
    expect(dbConnectMock).toHaveBeenCalledTimes(1);
  });
});
