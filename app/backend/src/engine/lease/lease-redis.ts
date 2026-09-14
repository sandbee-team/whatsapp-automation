import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';

/**
 * lease-redis.ts (P06 Unit U4) - a lease-scoped wrapper over the platform
 * Redis client (`platform/redis.ts`), loading the four Lua scripts under
 * `./scripts/` via `defineCommand` (EVAL once, EVALSHA thereafter - same
 * "ioredis tracks the SHA and falls back to EVAL on NOSCRIPT" pattern as
 * `platform/http/rate-limit.ts`).
 *
 * KEY-SHAPE DEVIATION (recorded per the P06 dispatch): the phase file's
 * literal was `wp:{env}:lease:c:{client}:i:{instance}`, but the sanctioned
 * `tenantKey()` helper (platform/redis/keys.ts) produces
 * `wp:{env}:c:{client}:lease:i:{instance}` - semantics identical (env,
 * tenant, and instance are all still encoded and still collision-free
 * across tenants/instances), and raw `wp:` literals outside
 * platform/redis/** are guard-banned (wp/key-construction), so the helper
 * wins. Callers building a lease key MUST use
 * `tenantKey(env, clientId, 'lease', 'i', instanceId)`.
 *
 * TIMEOUT: every command is wrapped in a hard timeout (default
 * `TIMING.redisCommandTimeoutMs`) that REJECTS on expiry - the underlying
 * ioredis call is left to settle on its own; the wrapper does not depend on
 * (and must not wait for) the client's own timeout/retry behaviour, because
 * a half-open TCP connection can leave an in-flight command pending
 * indefinitely. `release`/`setFence`/`acquire`/`renewBatch` all reject (never
 * silently resolve `false`) when the timeout fires or the underlying call
 * errors - core invariant 2: a caller must be able to tell "Redis said no"
 * (a real 0) apart from "Redis is unreachable" (a rejection), because only
 * the former is safe to self-fence on without further doubt, and only the
 * latter must feed the watchdog instead of being treated as an immediate
 * fence loss.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(HERE, 'scripts');

function readScript(name: string): string {
  return readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
}

const ACQUIRE_LUA = readScript('acquire.lua');
const SET_FENCE_LUA = readScript('set-fence.lua');
const RENEW_BATCH_LUA = readScript('renew-batch.lua');
const RELEASE_LUA = readScript('release.lua');

interface RedisWithLeaseCommands extends Redis {
  wpLeaseAcquire?(...args: (string | number)[]): Promise<number>;
  wpLeaseSetFence?(...args: (string | number)[]): Promise<number>;
  wpLeaseRenewBatch?(...args: (string | number)[]): Promise<number[]>;
  wpLeaseRelease?(...args: (string | number)[]): Promise<number>;
}

export interface RenewBatchEntry {
  key: string;
  value: string;
}

export interface LeaseRedis {
  acquire(key: string, workerId: string, ttlMs: number): Promise<boolean>;
  setFence(key: string, workerId: string, fence: bigint, ttlMs: number): Promise<boolean>;
  renewBatch(entries: RenewBatchEntry[], ttlMs: number): Promise<boolean[]>;
  release(key: string, value: string): Promise<boolean>;
}

export interface LeaseRedisOptions {
  /** Hard per-command timeout in ms. Defaults to `TIMING.redisCommandTimeoutMs`. */
  timeoutMs: number;
  /** Injectable for tests - defaults to the real `setTimeout`/`clearTimeout`. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

class LeaseRedisTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`lease-redis: '${command}' timed out after ${String(timeoutMs)}ms`);
    this.name = 'LeaseRedisTimeoutError';
  }
}

/**
 * Races `run()` against a hard timeout. The timer is always cleared
 * (success, failure, or timeout) so no dangling timer keeps the process
 * alive or fires after the fact. On timeout, the returned promise rejects
 * with `LeaseRedisTimeoutError` - the underlying `run()` promise's eventual
 * settlement (if any) is ignored.
 */
function withTimeout<T>(
  run: () => Promise<T>,
  command: string,
  options: LeaseRedisOptions,
): Promise<T> {
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeoutFn(() => {
      if (settled) return;
      settled = true;
      reject(new LeaseRedisTimeoutError(command, options.timeoutMs));
    }, options.timeoutMs);

    run().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        reject(err as Error);
      },
    );
  });
}

/** Creates a `LeaseRedis` backed by `redis`, defining the Lua commands once per connection. */
export function createLeaseRedis(redis: Redis, options: LeaseRedisOptions): LeaseRedis {
  const client = redis as RedisWithLeaseCommands;
  if (typeof client.wpLeaseAcquire !== 'function') {
    redis.defineCommand('wpLeaseAcquire', { lua: ACQUIRE_LUA, numberOfKeys: 1 });
  }
  if (typeof client.wpLeaseSetFence !== 'function') {
    redis.defineCommand('wpLeaseSetFence', { lua: SET_FENCE_LUA, numberOfKeys: 1 });
  }
  if (typeof client.wpLeaseRenewBatch !== 'function') {
    redis.defineCommand('wpLeaseRenewBatch', { lua: RENEW_BATCH_LUA });
  }
  if (typeof client.wpLeaseRelease !== 'function') {
    redis.defineCommand('wpLeaseRelease', { lua: RELEASE_LUA, numberOfKeys: 1 });
  }

  return {
    async acquire(key: string, workerId: string, ttlMs: number): Promise<boolean> {
      const result = await withTimeout(
        () => client.wpLeaseAcquire!(key, workerId, ttlMs),
        'acquire',
        options,
      );
      return result === 1;
    },

    async setFence(key: string, workerId: string, fence: bigint, ttlMs: number): Promise<boolean> {
      const result = await withTimeout(
        () => client.wpLeaseSetFence!(key, workerId, fence.toString(), ttlMs),
        'setFence',
        options,
      );
      return result === 1;
    },

    async renewBatch(entries: RenewBatchEntry[], ttlMs: number): Promise<boolean[]> {
      if (entries.length === 0) {
        return [];
      }

      const keys = entries.map((entry) => entry.key);
      const values = entries.map((entry) => entry.value);
      const result = await withTimeout(
        () => client.wpLeaseRenewBatch!(entries.length, ...keys, ttlMs, ...values),
        'renewBatch',
        options,
      );
      return result.map((value) => value === 1);
    },

    async release(key: string, value: string): Promise<boolean> {
      const result = await withTimeout(
        () => client.wpLeaseRelease!(key, value),
        'release',
        options,
      );
      return result === 1;
    },
  };
}
