import '../../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createEncryptedAuthStore } from './store.js';
import type {
  AuthStoreIdentity,
  AuthStorePorts,
  CreateEncryptedAuthStoreDeps,
  EncryptedAuthStore,
} from './types.js';
import type { AuthCodec } from './codec.js';
import type { SignalRedisRepo } from './redis-repo.js';
import type { SealedBlob } from '@wp/server-kit/crypto';
import type { SignalMetricsHandles } from '../../../platform/metrics/signal-metrics.js';

/**
 * bounded-key-store-config.test.ts (P10 Unit U5, step 6) - the config-
 * plumbing tests for `SIGNAL_KEYSTORE_MAX_RECORDS`, split out of
 * `bounded-key-store.test.ts` purely to stay under the repo's `max-lines`
 * guard (same reasoning as `pg-repo.ts`/`pg-repo-keys.ts`'s own split).
 * Exercises the store through the SAME production wiring path store.ts uses
 * (`createEncryptedAuthStore(...).asSignalKeyStore()`), never
 * `makeBoundedSignalKeyStore` directly, so a regression in the config ->
 * deps threading itself (not just the cache logic) would be caught here.
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

/** Builds a `createEncryptedAuthStore` instance via the SAME production wiring path store.ts uses. */
function buildProductionStore(deps: {
  metrics: SignalMetricsHandles;
  signalKeystoreMaxRecords?: number;
}): EncryptedAuthStore {
  const pgRepoStub = {
    saveCreds: vi.fn(),
    classifyWriteMiss: vi.fn().mockResolvedValue('version_conflict'),
    loadCreds: vi.fn(),
    purgeDurable: vi.fn(),
    getKeys: vi.fn().mockResolvedValue(new Map()),
    setKeys: vi.fn(),
  } as unknown as CreateEncryptedAuthStoreDeps['pgRepo'];

  return createEncryptedAuthStore({
    db: {} as CreateEncryptedAuthStoreDeps['db'],
    pgRepo: pgRepoStub,
    redisRepo: makeNoopRedisRepo(),
    codec: makeCodecStub(),
    identity: makeIdentity(),
    ports: makePorts(),
    metrics: deps.metrics,
    signalKeystoreMaxRecords: deps.signalKeystoreMaxRecords,
  });
}

describe('keystore_max_records_comes_from_config_not_a_literal', () => {
  it('changing SIGNAL_KEYSTORE_MAX_RECORDS changes eviction behaviour through the production wiring path', async () => {
    // No `512` literal remains anywhere in bounded-key-store.ts - the draft
    // cap was replaced by the domain constant (P07) and is now additionally
    // overridable via config (P10 Unit U5, step 6).
    const modulePath = fileURLToPath(new URL('./bounded-key-store.ts', import.meta.url));
    const source = readFileSync(modulePath, 'utf8');
    expect(source.includes('512')).toBe(false);

    // A small cap (5) evicts almost immediately.
    const smallCapMetrics = makeMetricsStub();
    const smallCapStore = buildProductionStore({
      metrics: smallCapMetrics,
      signalKeystoreMaxRecords: 5,
    });
    const smallCapKeyStore = smallCapStore.asSignalKeyStore();
    for (let i = 0; i < 10; i += 1) {
      await smallCapKeyStore.set({ session: { [`k${String(i)}`]: new Uint8Array([i % 256]) } });
    }
    expect(smallCapMetrics.incrementEvicted).toHaveBeenCalled();

    // A large cap (4000, the config default) does not evict for the same 10
    // writes.
    const largeCapMetrics = makeMetricsStub();
    const largeCapStore = buildProductionStore({
      metrics: largeCapMetrics,
      signalKeystoreMaxRecords: 4000,
    });
    const largeCapKeyStore = largeCapStore.asSignalKeyStore();
    for (let i = 0; i < 10; i += 1) {
      await largeCapKeyStore.set({ session: { [`k${String(i)}`]: new Uint8Array([i % 256]) } });
    }
    expect(largeCapMetrics.incrementEvicted).not.toHaveBeenCalled();
  });
});

describe('two_thousand_distinct_recipients_do_not_thrash_the_lru', () => {
  it('a 2,000-recipient broadcast fan-out stays under the DEFAULT keystore cap with zero evictions and zero eviction-caused decrypt failures', async () => {
    // Simulates a 2,000-recipient broadcast: 2,000 distinct session records,
    // each set() then get() once, through the bounded store built via the
    // SAME production wiring path store.ts uses (config -> asSignalKeyStore).
    // At the DEFAULT cap (SIGNAL_KEYSTORE_MAX_RECORDS=4000 > 2000) this must
    // never evict. The measured-budget assertion PROPER (an eviction-rate
    // ceiling under a real measured memory/record budget) arrives with M3's
    // real numbers at P10a - this test only pins today's defensible default
    // (4000) against today's structural target (2,000 recipients).
    const metrics = makeMetricsStub();
    const store = buildProductionStore({ metrics }); // no override -> config default (4000)
    const keyStore = store.asSignalKeyStore();

    for (let i = 0; i < 2000; i += 1) {
      const id = `recipient-${String(i)}`;
      await keyStore.set({ session: { [id]: new Uint8Array([i % 256]) } });
      await keyStore.get('session', [id]);
    }

    expect(metrics.incrementEvicted).not.toHaveBeenCalled();
    expect(metrics.incrementDecryptFailure).not.toHaveBeenCalled();
  });
});
