import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';
import { classifyAuthKeyType, SIGNAL_KEY_TTL_MS } from '@wp/domain';
import { logger as defaultLogger, type WpLogger } from '@wp/server-kit';
import { tenantKey } from '../../../platform/redis.js';
import { runFieldCapCheck } from './redis-repo-field-cap.js';
import {
  RedisCommandTimeoutError,
  RedisFenceGateError,
  runWrite,
  SignalStateReadTimeoutError,
  withTimeout,
  type WithTimeoutOptions,
} from './redis-repo-timeout.js';

export {
  RedisFenceGateError,
  SignalStateReadTimeoutError,
  SignalStateWriteError,
} from './redis-repo-timeout.js';

/**
 * redis-repo.ts (P07 Unit U3, step 6; hardened FIX-A WARNING-2/3/6) - the
 * Signal Redis repo: one HASH per (instance, key_type), keyed only through
 * `tenantKey()`, fields = key_id, values = opaque sealed-envelope `Buffer`s
 * produced by U1's `AuthCodec.encodeSealedBlob` (this file does NO crypto and
 * NO JSON - it deals in opaque blobs only).
 *
 * `SIGNAL_KEY_TYPES` (`session`, `sender-key`, `identity-key`) route to
 * `redisSig` (noeviction tier); `REBUILDABLE_KEY_TYPES` (`sender-key-memory`,
 * `lid-mapping`, `device-list`, `tctoken`) route to `redisCache`. Tier
 * routing is ALWAYS via `classifyAuthKeyType()` - never a local map.
 * `DURABLE_KEY_TYPES` never reach this repo (the store routes them to
 * Postgres) - a durable type here throws rather than being silently
 * misrouted.
 *
 * HMGET/HSET/HDEL only - never HGETALL, never SCAN - so `purgeInstance` is a
 * bounded `DEL` of exactly the (up to) seven possible hash keys (3 sig + 4
 * cache) PLUS the two fence-gate keys (one per tier), never a keyspace scan.
 *
 * WARNING-3 (Redis write TOCTOU): `setKeys` takes the caller's `fence` and
 * gates every hash write through `fence-gate-write.lua` - see that script's
 * header for the full mechanism. The fence is NEVER part of the hash key
 * itself (that would orphan a live Signal record's decryptability on
 * takeover, ADR 0018 S5); it lives only in a separate per-(tier, instance)
 * gate key.
 *
 * C2-F2 (unbounded Redis commands): EVERY command below (reads AND writes,
 * both tiers) is wrapped in `withTimeout` (`redis-repo-timeout.ts`, bounded by
 * `TIMING.redisCommandTimeoutMs`, the same bound `lease-redis.ts` uses) - a
 * write timeout surfaces as `SignalStateWriteError` (cause preserved), a
 * read timeout as `SignalStateReadTimeoutError`.
 */

const SIG_KEY_TYPES = ['session', 'sender-key', 'identity-key'] as const;
const CACHE_KEY_TYPES = ['sender-key-memory', 'lid-mapping', 'device-list', 'tctoken'] as const;

/** 30 days - both the fence-gate key's own TTL and (unchanged) the hash TTL. */
const FENCE_GATE_TTL_MS = SIGNAL_KEY_TTL_MS;

/** P10 U5 step 6: deps-absent fallback, matches `config.ts`'s own default exactly. */
const DEFAULT_MAX_FIELDS_PER_INSTANCE = 4000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(HERE, 'scripts');
const FENCE_GATE_WRITE_LUA = readFileSync(path.join(SCRIPTS_DIR, 'fence-gate-write.lua'), 'utf8');

export interface SignalRedisRepoRef {
  clientId: string;
  instanceId: string;
}

export interface SignalRedisRepoWrite {
  keyType: string;
  keyId: string;
  /** `null` means DELETE the field. */
  value: Buffer | null;
}

export interface SignalRedisRepo {
  getKeys(ref: SignalRedisRepoRef, keyType: string, ids: string[]): Promise<Map<string, Buffer>>;
  setKeys(
    ref: SignalRedisRepoRef,
    writes: SignalRedisRepoWrite[],
    fence: bigint | number,
  ): Promise<void>;
  purgeInstance(ref: SignalRedisRepoRef): Promise<void>;
}

export interface CreateSignalRedisRepoDeps extends WithTimeoutOptions {
  redisSig: Redis;
  redisCache: Redis;
  env: string;
  /** P10 U5 step 6: `config.REDIS_SIG_MAX_FIELDS_PER_INSTANCE` - optional, defaults to 4000 (matches config). */
  maxFieldsPerInstance?: number;
  /** P10 U5 step 6: field-cap observability - optional no-op; production wiring passes the shared `SignalMetricsHandles`. */
  fieldCapMetrics?: {
    incrementRedisSigFieldEvicted: () => void;
    incrementRedisSigFieldCapReached: () => void;
  };
  /** Overridable for tests only - defaults to `@wp/server-kit`'s shared logger. */
  logger?: WpLogger;
}

interface RedisWithFenceGate extends Redis {
  wpSignalFenceGateWrite?(...args: (string | number | Buffer)[]): Promise<number>;
}

function ensureFenceGateCommand(redis: Redis): void {
  const client = redis as RedisWithFenceGate;
  if (typeof client.wpSignalFenceGateWrite !== 'function') {
    redis.defineCommand('wpSignalFenceGateWrite', { lua: FENCE_GATE_WRITE_LUA, numberOfKeys: 2 });
  }
}

function hashKeyFor(
  env: string,
  ref: SignalRedisRepoRef,
  tier: 'sig' | 'cache',
  keyType: string,
): string {
  return tenantKey(env, ref.clientId, tier, 'i', ref.instanceId, 'h', keyType);
}

function gateKeyFor(env: string, ref: SignalRedisRepoRef, tier: 'sig' | 'cache'): string {
  return tenantKey(env, ref.clientId, tier, 'i', ref.instanceId, 'fence');
}

function redisAndTierFor(
  deps: CreateSignalRedisRepoDeps,
  keyType: string,
): { redis: Redis; tier: 'sig' | 'cache' } {
  const classification = classifyAuthKeyType(keyType);
  if (classification === 'signal') {
    return { redis: deps.redisSig, tier: 'sig' };
  }
  if (classification === 'rebuildable') {
    return { redis: deps.redisCache, tier: 'cache' };
  }
  throw new Error(
    `redis-repo received a "${classification}" auth key type ("${keyType}") - durable key types never reach this repo`,
  );
}

/**
 * Builds a `SignalRedisRepo` bound to `deps.redisSig`/`deps.redisCache`.
 */
export function createSignalRedisRepo(deps: CreateSignalRedisRepoDeps): SignalRedisRepo {
  ensureFenceGateCommand(deps.redisSig);
  ensureFenceGateCommand(deps.redisCache);

  return {
    async getKeys(ref, keyType, ids) {
      if (ids.length === 0) {
        return new Map();
      }

      const { redis, tier } = redisAndTierFor(deps, keyType);
      const key = hashKeyFor(deps.env, ref, tier, keyType);

      let values: (Buffer | null)[];
      try {
        values = await withTimeout(() => redis.hmgetBuffer(key, ...ids), 'hmgetBuffer', deps);
      } catch (err) {
        if (err instanceof RedisCommandTimeoutError) {
          throw new SignalStateReadTimeoutError(
            `Timed out reading Signal auth-state key(s) from Redis: ${err.message}`,
            { cause: err },
          );
        }
        throw err;
      }

      const result = new Map<string, Buffer>();
      ids.forEach((id, index) => {
        const raw = values[index];
        if (raw !== null && raw !== undefined) {
          result.set(id, raw);
        }
      });
      return result;
    },

    async setKeys(ref, writes, fence) {
      if (writes.length === 0) {
        return;
      }

      // Group per (tier, hash key) so each hash gets ONE gated fence-gate
      // EVAL, not one round-trip per field.
      const byHash = new Map<
        string,
        {
          redis: Redis;
          tier: 'sig' | 'cache';
          key: string;
          keyType: string;
          sets: Record<string, Buffer>;
          dels: string[];
        }
      >();

      for (const write of writes) {
        const { redis, tier } = redisAndTierFor(deps, write.keyType);
        const key = hashKeyFor(deps.env, ref, tier, write.keyType);
        let bucket = byHash.get(key);
        if (!bucket) {
          bucket = { redis, tier, key, keyType: write.keyType, sets: {}, dels: [] };
          byHash.set(key, bucket);
        }
        if (write.value === null) {
          bucket.dels.push(write.keyId);
        } else {
          bucket.sets[write.keyId] = write.value;
        }
      }

      const fenceStr = fence.toString();
      const capLogger = deps.logger ?? defaultLogger;
      const maxFieldsPerInstance = deps.maxFieldsPerInstance ?? DEFAULT_MAX_FIELDS_PER_INSTANCE;

      for (const bucket of byHash.values()) {
        const client = bucket.redis as RedisWithFenceGate;
        const gateKey = gateKeyFor(deps.env, ref, bucket.tier);

        const setEntries = Object.entries(bucket.sets);

        // P10 Unit U5 (step 6): the field-cap guard runs BEFORE the real
        // HSET, using this SAME hash key, so a REBUILDABLE-tier trim frees
        // room before the write and a SIGNAL-tier alarm observes the
        // pre-write state. See `redis-repo-field-cap.ts`'s own doc comment
        // for the idempotency/tenant-isolation reasoning.
        await runFieldCapCheck(bucket, ref, {
          ...deps,
          maxFieldsPerInstance,
          logger: capLogger,
        });
        const args: (string | number | Buffer)[] = [
          fenceStr,
          FENCE_GATE_TTL_MS,
          SIGNAL_KEY_TTL_MS,
          setEntries.length,
        ];
        for (const [field, value] of setEntries) {
          args.push(field, value);
        }
        args.push(bucket.dels.length);
        for (const field of bucket.dels) {
          args.push(field);
        }

        const result = await runWrite(
          () => client.wpSignalFenceGateWrite!(gateKey, bucket.key, ...args),
          'wpSignalFenceGateWrite',
          deps,
          'Failed to write Signal auth-state key(s) to Redis',
        );

        if (result === 0) {
          throw new RedisFenceGateError(ref.instanceId);
        }
      }
    },

    async purgeInstance(ref) {
      const sigKeys = SIG_KEY_TYPES.map((keyType) => hashKeyFor(deps.env, ref, 'sig', keyType));
      const cacheKeys = CACHE_KEY_TYPES.map((keyType) =>
        hashKeyFor(deps.env, ref, 'cache', keyType),
      );
      const sigGateKey = gateKeyFor(deps.env, ref, 'sig');
      const cacheGateKey = gateKeyFor(deps.env, ref, 'cache');

      await runWrite(
        () => deps.redisSig.del(...sigKeys, sigGateKey),
        'del',
        deps,
        'Failed to purge Signal auth-state keys from Redis',
      );
      await runWrite(
        () => deps.redisCache.del(...cacheKeys, cacheGateKey),
        'del',
        deps,
        'Failed to purge Signal auth-state keys from Redis',
      );
    },
  };
}
