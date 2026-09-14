import type { createRedis } from '../../../platform/redis.js';

/**
 * fleet-bucket-snapshot.ts - shared test-only helpers for reading the real
 * fleet connect-bucket's own accounting (`tokens`/`lastRefillMs`) and the
 * Redis server's own `TIME`, extracted out of
 * `fleet-connect-bucket-e3-edge.integration.test.ts`'s 2026-09-01 fix
 * (`readBucket`/`redisNowMs`) so `fleet-recovery-storm.integration.test.ts`
 * can reuse the identical conservation-identity pattern (2026-09-02) rather
 * than re-deriving it. No behavior change to the e3-edge file's own proof -
 * pure extraction.
 */

/** Bucket hash field readout - same shape `take-token.lua` stores. */
export interface BucketSnapshot {
  tokens: number;
  lastRefillMs: number;
}

export async function readBucket(
  redis: ReturnType<typeof createRedis>,
  key: string,
): Promise<BucketSnapshot> {
  const raw = await redis.hgetall(key);
  return { tokens: Number(raw.tokens), lastRefillMs: Number(raw.lastRefillMs) };
}

/** Redis server `TIME` (ms) - the SAME clock `take-token.lua` refills against, never a local wall clock (workers can be skewed; the bucket cannot). */
export async function redisNowMs(redis: ReturnType<typeof createRedis>): Promise<number> {
  const [seconds, microseconds] = await redis.time();
  return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
}
