import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRedis, resolveRedisUrl, sysKey } from '../../redis.js';
import { createRateLimiter, type RateLimitScope } from '../rate-limit.js';

/**
 * rate-limit.integration.test.ts (P04a Unit A4) - the token-bucket limiter,
 * proven against a real Redis. Each test uses a unique key prefix and
 * deletes its own keys in `afterEach` (`resolveRedisUrl` mirrors
 * `platform/db/db-url.ts`'s dev-stack port resolution).
 */

function uniqueKey(label: string): string {
  return sysKey('test', 'rl', label, randomUUID());
}

describe('rate-limit (P04a Unit A4, token-bucket limiter)', () => {
  let redis: ReturnType<typeof createRedis> | undefined;
  const createdKeys: string[] = [];

  afterEach(async () => {
    if (redis && createdKeys.length > 0) {
      try {
        await redis.del(...createdKeys);
      } catch {
        // Best-effort cleanup only - the "unreachable" test's connection
        // never comes up, so a DEL there would just be more noise.
      }
    }
    createdKeys.length = 0;
    redis?.disconnect();
    redis = undefined;
  });

  it('bucket_denies_request_n_plus_1_with_retry_after', async () => {
    redis = createRedis(resolveRedisUrl());
    const limiter = createRateLimiter(redis);
    const key = uniqueKey('capacity3');
    createdKeys.push(key);
    const scope: RateLimitScope = { key, capacity: 3, refillPerSec: 0.001 };

    const first = await limiter.consume([scope]);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);

    const second = await limiter.consume([scope]);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(1);

    const third = await limiter.consume([scope]);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    const fourth = await limiter.consume([scope]);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it('strictest_scope_wins_and_denial_consumes_nothing', async () => {
    redis = createRedis(resolveRedisUrl());
    const limiter = createRateLimiter(redis);
    const emptyKey = uniqueKey('empty');
    const healthyKey = uniqueKey('healthy');
    createdKeys.push(emptyKey, healthyKey);

    const emptyScope: RateLimitScope = { key: emptyKey, capacity: 1, refillPerSec: 0.001 };
    const healthyScope: RateLimitScope = { key: healthyKey, capacity: 5, refillPerSec: 0.001 };

    // Exhaust the "empty" bucket first.
    await limiter.consume([emptyScope]);

    const denied = await limiter.consume([emptyScope, healthyScope]);
    expect(denied.allowed).toBe(false);

    // The denied combined call must not have cost the healthy bucket a
    // token: a fresh solo consume against it should show exactly ONE
    // deduction (this call's own), not two.
    const healthySolo = await limiter.consume([healthyScope]);
    expect(healthySolo.remaining).toBe(healthyScope.capacity - 1);
  });

  it('ten_parallel_requests_against_a_capacity_three_bucket_allow_exactly_three', async () => {
    // Sequential draining (the test above) never exercises the Lua script's
    // own atomicity - a real burst of concurrent callers is the only thing
    // that can catch a check-then-decrement race. Fire N=10 REAL concurrent
    // `consume` calls (not a loop of awaits) against one capacity-3 bucket.
    redis = createRedis(resolveRedisUrl());
    const limiter = createRateLimiter(redis);
    const key = uniqueKey('concurrent-capacity3');
    createdKeys.push(key);
    const scope: RateLimitScope = { key, capacity: 3, refillPerSec: 0.001 };

    const results = await Promise.all(Array.from({ length: 10 }, () => limiter.consume([scope])));

    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(3);
  });

  it('redis_unavailable_fails_closed_for_auth_scopes', async () => {
    redis = createRedis('redis://127.0.0.1:1');
    const limiter = createRateLimiter(redis);
    const key = uniqueKey('dead');

    const result = await limiter.consume([{ key, capacity: 5, refillPerSec: 1, failClosed: true }]);
    expect(result.allowed).toBe(false);
  });
});
