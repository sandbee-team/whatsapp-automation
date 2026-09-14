import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { createFleetTokenBucket } from './connect-budget.js';

/**
 * connect-budget.integration.test.ts (P09 Unit U2 step 4) - the phase file
 * guesses `app/backend/test/integration/fleet/connect-budget.int.test.ts`,
 * but the repo's actual convention is a colocated `*.integration.test.ts`
 * file picked up by `app/backend/vitest.config.ts`'s
 * `include: ['src/**\/*.integration.test.ts']` (see e.g.
 * `session-worker-scan.integration.test.ts`) - this file follows that
 * convention instead (reported as a deviation).
 *
 * Proves the fleet bucket is genuinely fleet-wide: 3 separate
 * `createFleetTokenBucket` instances (simulating 3 workers, each with its
 * own ioredis connection) hammer the SAME bucket key (unique env per test
 * run so parallel runs never collide) at a fixed rate; total successful
 * takes across all 3 in one wall-clock second never exceed the configured
 * rate - bucket capacity == rate is the property under test.
 */

describe('fleet connect token bucket - real Redis, fleet-wide', () => {
  const redisHandles: ReturnType<typeof createRedis>[] = [];

  afterAll(() => {
    for (const redis of redisHandles) {
      redis.disconnect();
    }
  });

  it('connect_bucket_is_fleet_wide_not_per_worker', async () => {
    const env = `it-${randomUUID()}`;
    const rate = 10;

    const workerCount = 3;
    const buckets = Array.from({ length: workerCount }, () => {
      const redis = createRedis(resolveRedisUrl());
      redisHandles.push(redis);
      return createFleetTokenBucket({
        redis,
        env,
        getRatePerSec: async () => rate,
        ttlMs: 10_000,
      });
    });

    // Hammer all 3 buckets concurrently, well beyond what `rate` allows in
    // one second, and count successful takes.
    const attemptsPerWorker = 50;
    const results = await Promise.all(
      buckets.flatMap((bucket) => Array.from({ length: attemptsPerWorker }, () => bucket.take())),
    );

    const successCount = results.filter(Boolean).length;

    // All attempts fire within well under a second (no waiting between
    // takes), so this is a single refill window: capacity == rate means
    // total successful takes across the whole fleet can never exceed rate.
    expect(successCount).toBeLessThanOrEqual(rate);
    expect(successCount).toBeGreaterThan(0);
  }, 15000);
});
