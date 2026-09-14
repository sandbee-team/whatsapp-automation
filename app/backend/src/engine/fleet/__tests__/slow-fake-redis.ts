import type { Redis } from 'ioredis';

/**
 * slow-fake-redis.ts - additive test-only seam for
 * `fleet-c2-slow-redis.integration.test.ts` (2026-09-02 regression fix, see
 * that file's header for the full root-cause writeup). A fully in-memory
 * fake hash store implementing only the three commands
 * `publishWorkerPap`/`readFleetCapacityHeadroom`/`discovery.ts` actually
 * call (`hset`/`hgetall`/`hdel`) - no real network call, so the injected
 * `SLOW_MS` delay is the ONLY latency in play, never real Redis round-trip
 * time layered on top of it (that layering was the regression's actual
 * mechanism: real network latency plus the injected sleep occasionally
 * pushed total elapsed time past the real 2s
 * `TIMING.redisCommandTimeoutMs` budget under host load).
 *
 * Deliberately narrow: only the three hash commands `discovery-caps.ts`
 * calls are implemented; anything else throws, so a future caller that
 * needs a new command gets a loud signal here rather than a silent
 * undefined-is-not-a-function failure deep in production code.
 */
export function createSlowFakeRedis(slowMs: number): Redis {
  const store = new Map<string, Map<string, string>>();
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  function hashFor(key: string): Map<string, string> {
    let hash = store.get(key);
    if (!hash) {
      hash = new Map();
      store.set(key, hash);
    }
    return hash;
  }

  const fake = {
    async hset(key: string, field: string, value: string): Promise<number> {
      await sleep(slowMs);
      const hash = hashFor(key);
      const isNew = !hash.has(field);
      hash.set(field, value);
      return isNew ? 1 : 0;
    },
    async hgetall(key: string): Promise<Record<string, string>> {
      await sleep(slowMs);
      return Object.fromEntries(hashFor(key));
    },
    async hdel(key: string, ...fields: string[]): Promise<number> {
      await sleep(slowMs);
      const hash = hashFor(key);
      let removed = 0;
      for (const field of fields) {
        if (hash.delete(field)) removed += 1;
      }
      return removed;
    },
  };

  return fake as unknown as Redis;
}
