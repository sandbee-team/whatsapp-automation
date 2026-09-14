import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { sysKey } from '../../platform/redis/keys.js';
import { createFleetTokenBucket } from './connect-budget.js';
import { readBucket, redisNowMs } from './__tests__/fleet-bucket-snapshot.js';

/**
 * fleet-connect-bucket-e3-edge.integration.test.ts - P09 E3 edge-case pass,
 * split out of `fleet-integration-e3-edge.integration.test.ts` at
 * FIX-P09-B for the max-lines cap (topic split only - same cases,
 * unchanged). Two properties:
 *
 *   1. Fleet connect-bucket race down to the LAST remaining token: N
 *      concurrent takers race a near-drained bucket - no lost update, ever
 *      (connect-budget.integration.test.ts proves fleet-wideness from a
 *      fresh/full bucket, not this near-empty edge). Real Redis.
 *   2. Provider outage tracker's exact 20% boundary - deterministic, fake
 *      Redis.
 *
 * See `fleet-discovery-race-e3-edge.integration.test.ts` for the two
 * in-process discovery loop racing cases.
 */

const redisHandles: ReturnType<typeof createRedis>[] = [];

afterAll(() => {
  for (const h of redisHandles) {
    h.disconnect();
  }
});

describe('fleet connect token bucket - exact last-token race (real Redis)', () => {
  it('N_concurrent_takers_against_a_near_drained_bucket_never_hand_out_more_tokens_than_actually_existed', async () => {
    const redis = createRedis(resolveRedisUrl());
    redisHandles.push(redis);

    const env = `it-e3-${randomUUID()}`;
    const rate = 20; // capacity == rate; we drain it down to near-1 first.
    const bucketKey = sysKey(env, 'sys', 'tb', 'connect');
    const bucket = createFleetTokenBucket({
      redis,
      env,
      getRatePerSec: async () => rate,
      ttlMs: 60_000,
    });

    // Drain the bucket down to close to 1 remaining token by taking
    // `rate - 1` tokens sequentially. Each of these round trips also
    // refills a little (continuous time-based refill against Redis server
    // TIME - see take-token.lua's header) - each take still succeeds
    // regardless, since refill only ever ADDS tokens.
    for (let i = 0; i < rate - 1; i++) {
      const ok = await bucket.take();
      expect(ok).toBe(true);
    }

    const before = await readBucket(redis, bucketKey);

    // N concurrent takers race for whatever remains (nominally ~1 token,
    // but real time has passed since the drain loop above, so the bucket
    // may hold slightly more - see the file-level property doc and the
    // accounting identity below, which is exact regardless of how much
    // ambient time elapsed).
    const N = 15;
    const buckets = Array.from({ length: N }, () => {
      const workerRedis = createRedis(resolveRedisUrl());
      redisHandles.push(workerRedis);
      return createFleetTokenBucket({
        redis: workerRedis,
        env,
        getRatePerSec: async () => rate,
        ttlMs: 60_000,
      });
    });

    const results = await Promise.all(buckets.map((b) => b.take()));
    const successCount = results.filter(Boolean).length;

    const raceEndMs = await redisNowMs(redis);
    const after = await readBucket(redis, bucketKey);

    // Conservation, computed from the bucket's OWN accounting rather than a
    // sampled count - this is the invariant the case is actually about
    // (atomicity: the bucket never hands out more tokens than it actually
    // held, i.e. no lost update under concurrency), and it holds no matter
    // how much ambient load shifts the wall-clock timing of the drain loop
    // or the race itself (core-invariants: never assert a race outcome
    // ambient load can perturb; assert the invariant that actually
    // matters).
    //
    // Upper bound on tokens available going into the race: `before.tokens`
    // anchored at `before.lastRefillMs` (the bucket's OWN last-write
    // timestamp, set by the drain loop's final take - never a separately
    // round-tripped `raceStartMs`, which lags `before.lastRefillMs` by
    // however long the `before` read itself took under ambient load,
    // silently UNDER-counting refill and making the ceiling too tight - the
    // exact bug this test used to have: `successCount` could exceed a
    // ceiling computed from a too-small refill window), plus every
    // millisecond of refill that could have happened for the rest of the
    // window up to `raceEndMs` (measured strictly after every concurrent
    // take() has resolved), per the SAME real-time refill formula
    // take-token.lua uses.
    const maxRefillDuringRace = ((raceEndMs - before.lastRefillMs) * rate) / 1000;
    const maxTokensAvailable = Math.min(rate, before.tokens + maxRefillDuringRace);
    expect(successCount).toBeGreaterThanOrEqual(1); // someone got a token - no starvation/deadlock
    expect(successCount).toBeLessThanOrEqual(Math.floor(maxTokensAvailable + 1e-9));

    // The bucket's post-race ledger is internally consistent: tokens spent
    // equals tokens taken, exactly (float tolerance for the ms-granularity
    // refill arithmetic Lua performs in double precision).
    const totalRefillObserved = ((after.lastRefillMs - before.lastRefillMs) * rate) / 1000;
    const expectedAfterTokens = Math.min(rate, before.tokens + totalRefillObserved) - successCount;
    expect(after.tokens).toBeCloseTo(expectedAfterTokens, 6);
  }, 20_000);
});

describe('provider outage tracker - exact 20 percent boundary (fake redis, deterministic)', () => {
  it('exactly_20_percent_of_desired_online_does_not_freeze_the_bucket', async () => {
    const { createOutageTracker } = await import('./connect-budget.js');
    const buckets = new Map<string, number>();
    const flags = new Map<string, string>();
    const fakeRedis = {
      async incrBucket(key: string): Promise<number> {
        const next = (buckets.get(key) ?? 0) + 1;
        buckets.set(key, next);
        return next;
      },
      async sumBuckets(keys: string[]): Promise<number> {
        return keys.reduce((sum, k) => sum + (buckets.get(k) ?? 0), 0);
      },
      async setFreezeFlag(key: string): Promise<void> {
        flags.set(key, '1');
      },
      async isFreezeFlagSet(key: string): Promise<boolean> {
        return flags.has(key);
      },
    };

    const desiredOnline = 100; // 20% threshold == 20 disconnects exactly.
    const tracker = createOutageTracker({
      redis: fakeRedis,
      env: 'test',
      getDesiredOnline: async () => desiredOnline,
      now: () => 0,
    });

    // Exactly 20 disconnects = exactly 20% of desiredOnline. The rule is
    // "> 20%", so this must NOT freeze.
    for (let i = 0; i < 20; i++) {
      await tracker.noteDisconnect(503);
    }
    expect(await tracker.isProviderOutage()).toBe(false);

    // One more disconnect crosses strictly above 20% -> freezes.
    await tracker.noteDisconnect(503);
    expect(await tracker.isProviderOutage()).toBe(true);
  });
});
