import type { createRedis } from '../../../platform/redis.js';
import { readBucket, redisNowMs, type BucketSnapshot } from './fleet-bucket-snapshot.js';

/**
 * fleet-recovery-bucket-conservation.ts - the fleet connect-bucket
 * conservation-bracket helpers for `fleet-recovery-storm.integration.test.ts`
 * (2026-09-02 fix), split into a sibling module to keep that file under the
 * workspace max-lines cap (topic split, same idiom as
 * `session-worker-discovery-wiring.ts`). See the storm test's own assertion
 * for the full rationale: a wall-clock-windowed-bin sample of connect
 * timestamps is a race outcome ambient load can perturb; the invariant the
 * bucket actually enforces is token conservation, read from its own
 * `tokens`/`lastRefillMs` vs Redis server `TIME` (same identity
 * `fleet-connect-bucket-e3-edge.integration.test.ts`'s 2026-09-01 fix uses).
 */

export interface BucketBracket {
  before: BucketSnapshot;
  beforeMs: number;
}

/**
 * Reads the bucket's state just before a spend exercise begins. A bucket key
 * that does not exist yet reads as empty (`tokens: NaN`) - treated exactly
 * like `take-token.lua`'s own initialization: a fresh bucket starts FULL as
 * of this read's own timestamp, never as empty (which would understate what
 * it could legitimately hand out and produce a false-positive ceiling
 * failure).
 */
export async function snapshotBucketBefore(
  redis: ReturnType<typeof createRedis>,
  key: string,
  ratePerSec: number,
): Promise<BucketBracket> {
  const beforeMs = await redisNowMs(redis);
  const raw = await readBucket(redis, key);
  const before = Number.isNaN(raw.tokens) ? { tokens: ratePerSec, lastRefillMs: beforeMs } : raw;
  return { before, beforeMs };
}

/**
 * Conservation ceiling over the WHOLE bracket (a standard token-bucket
 * throughput bound, not an instantaneous-capacity bound): the bucket starts
 * with at most `before.tokens` sitting in it (capped at `ratePerSec`, the
 * bucket's own capacity), and over the bracket's elapsed real time it can
 * additionally MINT up to `ratePerSec` tokens per second - continuously, not
 * just once - since every take that drains a token immediately makes room
 * for more real-time refill. Capacity only bounds how large a single BURST
 * can be, never the cumulative total dispensable over a multi-second/minute
 * exercise (the bug this ceiling replaces: `min(rate, before + refill)`
 * wrongly re-capped the running total at `rate` for the whole bracket,
 * failing standalone at `expected 18 <= 8` even though 18 legitimate takes
 * spread across the bracket's real elapsed time is exactly what an 8/s rate
 * over that many seconds allows). A bound on what the bucket COULD have
 * given out over the interval, never a sampled count of one wall-clock
 * window's contents.
 */
export function maxTokensAvailable(
  bracket: BucketBracket,
  afterMs: number,
  ratePerSec: number,
): number {
  const elapsedMs = afterMs - bracket.beforeMs;
  const startingTokens = Math.min(ratePerSec, bracket.before.tokens);
  const mintedDuringBracket = (elapsedMs * ratePerSec) / 1000;
  return startingTokens + mintedDuringBracket;
}
