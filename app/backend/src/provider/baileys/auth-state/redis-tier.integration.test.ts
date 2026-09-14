import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { Redis } from 'ioredis';
import {
  createRedis,
  resolveSigRedisUrl,
  resolveCacheRedisUrl,
  tenantKey,
} from '../../../platform/redis.js';
import {
  assertSignalKeyspacePolicy,
  SignalKeyspacePolicyError,
} from '../../../platform/redis-assertions.js';
import { createSignalRedisRepo, SignalStateWriteError } from './redis-repo.js';
import { SIGNAL_KEY_TTL_MS } from '@wp/domain';

/**
 * redis-tier.integration.test.ts (P07 Unit U3, steps 5-6) - the Redis tiering
 * split (redisSig/redisCache) and the Signal Redis repo, against real Redis
 * services (redisSig = redis-sig noeviction service, redisCache = the base
 * dev Redis - see .secrets/dev.env REDIS_SIG_PORT / REDIS_PORT).
 */

const ENV = 'test';

describe('assertSignalKeyspacePolicy', () => {
  it('signal_keyspace_must_be_noeviction_or_boot_fails', async () => {
    const stub = {
      config: async (sub: string, key: string) => {
        expect(sub).toBe('GET');
        expect(key).toBe('maxmemory-policy');
        return ['maxmemory-policy', 'allkeys-lru'];
      },
    } as unknown as Redis;

    await expect(assertSignalKeyspacePolicy(stub)).rejects.toThrow(SignalKeyspacePolicyError);
    await expect(assertSignalKeyspacePolicy(stub)).rejects.toThrow(/allkeys-lru/);

    const realSig = createRedis(resolveSigRedisUrl());
    await expect(assertSignalKeyspacePolicy(realSig)).resolves.toBeUndefined();
    realSig.disconnect();
  });
});

describe('createSignalRedisRepo', () => {
  let redisSig: Redis;
  let redisCache: Redis;
  const clientId = 'tenant-redis-repo';
  const instanceId = 'inst-1';

  beforeAll(() => {
    redisSig = createRedis(resolveSigRedisUrl());
    redisCache = createRedis(resolveCacheRedisUrl());
  });

  afterAll(() => {
    redisSig.disconnect();
    redisCache.disconnect();
  });

  afterEach(async () => {
    const repo = createSignalRedisRepo({ redisSig, redisCache, env: ENV });
    await repo.purgeInstance({ clientId, instanceId });
  });

  it('signal_write_failure_degrades_and_never_silently_continues', async () => {
    // The fence-gated write path (WARNING-3) runs through ONE Lua command
    // (`wpSignalFenceGateWrite`) rather than a direct `hset` - simulate a
    // failing underlying command at that level (`defineCommand`-registered
    // methods are plain functions on the client) instead of stubbing `hset`.
    // The field-cap check (P10 Unit U5) runs BEFORE this write on the same
    // bucket - these trivial, honest stubs let the cap check succeed
    // (nothing to trim/alarm on) so execution actually reaches the write
    // this test is proving fails; the cap-check methods are NOT the thing
    // under test here (see field-cap-guard tests for that).
    const failingSig = {
      defineCommand: () => undefined,
      hmget: async (_key: string, ...ids: string[]) => ids.map(() => null),
      hlen: async () => 0,
      hrandfield: async () => [],
      hdel: async () => 0,
      wpSignalFenceGateWrite: async () => {
        throw new Error('boom');
      },
    } as unknown as Redis;

    const repo = createSignalRedisRepo({ redisSig: failingSig, redisCache, env: ENV });

    const cause = new Error('boom');
    await expect(
      repo.setKeys(
        { clientId, instanceId },
        [{ keyType: 'session', keyId: 'k1', value: Buffer.from('v1') }],
        1n,
      ),
    ).rejects.toMatchObject({
      constructor: SignalStateWriteError,
      code: 'SIGNAL_STATE_WRITE_FAILED',
    });

    try {
      await repo.setKeys(
        { clientId, instanceId },
        [{ keyType: 'session', keyId: 'k1', value: Buffer.from('v1') }],
        1n,
      );
      expect.fail('expected setKeys to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(SignalStateWriteError);
      expect((err as InstanceType<typeof SignalStateWriteError>).code).toBe(
        'SIGNAL_STATE_WRITE_FAILED',
      );
      expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error);
      expect(((err as { cause?: unknown }).cause as Error).message).toBe(cause.message);
    }
  });

  it('round_trip_sets_and_gets_byte_identical_buffers_for_sig_and_cache_tiers', async () => {
    const repo = createSignalRedisRepo({ redisSig, redisCache, env: ENV });

    const sigValue = Buffer.from('sig-payload', 'utf8');
    const cacheValue = Buffer.from('cache-payload', 'utf8');

    await repo.setKeys(
      { clientId, instanceId },
      [
        { keyType: 'session', keyId: 'k1', value: sigValue },
        { keyType: 'sender-key-memory', keyId: 'k2', value: cacheValue },
      ],
      1n,
    );

    const sigResult = await repo.getKeys({ clientId, instanceId }, 'session', ['k1', 'missing']);
    expect(sigResult.size).toBe(1);
    expect(sigResult.get('k1')?.equals(sigValue)).toBe(true);
    expect(sigResult.has('missing')).toBe(false);

    const cacheResult = await repo.getKeys({ clientId, instanceId }, 'sender-key-memory', ['k2']);
    expect(cacheResult.get('k2')?.equals(cacheValue)).toBe(true);

    // PTTL of touched sig hash is > 0 and <= 30d after write.
    const hashKey = tenantKey(ENV, clientId, 'sig', 'i', instanceId, 'h', 'session');
    const pttlAfterWrite = await redisSig.pttl(hashKey);
    expect(pttlAfterWrite).toBeGreaterThan(0);
    expect(pttlAfterWrite).toBeLessThanOrEqual(SIGNAL_KEY_TTL_MS);

    // Add a second field so the hash survives deleting k1, then null value
    // deletes the field. Fence must be `>=` the first write's fence to clear
    // the fence gate.
    await repo.setKeys(
      { clientId, instanceId },
      [
        { keyType: 'session', keyId: 'k1b', value: Buffer.from('keep') },
        { keyType: 'session', keyId: 'k1', value: null },
      ],
      1n,
    );
    const afterDelete = await repo.getKeys({ clientId, instanceId }, 'session', ['k1', 'k1b']);
    expect(afterDelete.has('k1')).toBe(false);
    expect(afterDelete.get('k1b')?.equals(Buffer.from('keep'))).toBe(true);
  });

  it('purgeInstance_deletes_all_seven_possible_hash_keys_with_a_bounded_del', async () => {
    const repo = createSignalRedisRepo({ redisSig, redisCache, env: ENV });

    await repo.setKeys(
      { clientId, instanceId },
      [
        { keyType: 'session', keyId: 'k1', value: Buffer.from('v') },
        { keyType: 'sender-key-memory', keyId: 'k2', value: Buffer.from('v') },
      ],
      1n,
    );

    await repo.purgeInstance({ clientId, instanceId });

    const sigResult = await repo.getKeys({ clientId, instanceId }, 'session', ['k1']);
    expect(sigResult.size).toBe(0);
    const cacheResult = await repo.getKeys({ clientId, instanceId }, 'sender-key-memory', ['k2']);
    expect(cacheResult.size).toBe(0);
  });

  it('durable_key_types_are_rejected_by_this_repo', async () => {
    const repo = createSignalRedisRepo({ redisSig, redisCache, env: ENV });

    await expect(
      repo.setKeys(
        { clientId, instanceId },
        [{ keyType: 'pre-key', keyId: 'k1', value: Buffer.from('v') }],
        1n,
      ),
    ).rejects.toThrow();

    await expect(repo.getKeys({ clientId, instanceId }, 'pre-key', ['k1'])).rejects.toThrow();
  });
});
