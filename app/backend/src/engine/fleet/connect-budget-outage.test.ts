import { describe, expect, it } from 'vitest';
import { createOutageTracker } from './connect-budget.js';

/**
 * connect-budget-outage.test.ts (P09 Unit U2 step 4, FIX-P09-B split) - the
 * PROVIDER_OUTAGE freeze-decision cases, split out of
 * `connect-budget.test.ts` at FIX-P09-B for the max-lines cap (topic split
 * only - same cases, unchanged), against a FAKE Redis client (a minimal
 * stub of the handful of commands the module actually calls) - no real
 * Redis here.
 */

describe('provider outage tracker', () => {
  function makeFakeRedis() {
    const buckets = new Map<string, number>();
    const flags = new Map<string, string>();
    return {
      buckets,
      flags,
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
  }

  it('provider_outage_freezes_bucket_to_two_per_second', async () => {
    const redis = makeFakeRedis();
    const desiredOnline = 100;
    const tracker = createOutageTracker({
      redis,
      env: 'test',
      getDesiredOnline: async () => desiredOnline,
      now: () => 0,
    });

    // Below 20% threshold: no freeze.
    for (let i = 0; i < 15; i++) {
      await tracker.noteDisconnect(503);
    }
    expect(await tracker.isProviderOutage()).toBe(false);

    // Cross above 20% of desiredOnline (100 -> threshold 20): push to 25 total.
    for (let i = 0; i < 10; i++) {
      await tracker.noteDisconnect(503);
    }
    expect(await tracker.isProviderOutage()).toBe(true);
  });

  it('non_503_disconnects_do_not_count_toward_the_outage_threshold', async () => {
    const redis = makeFakeRedis();
    const tracker = createOutageTracker({
      redis,
      env: 'test',
      getDesiredOnline: async () => 10,
      now: () => 0,
    });

    for (let i = 0; i < 50; i++) {
      await tracker.noteDisconnect(401);
    }
    expect(await tracker.isProviderOutage()).toBe(false);
  });

  it('SUGGESTION FIX 11: a minute exactly OUTAGE_BUCKET_COUNT (5) apart never reuses the same bucket key (no stale-count collision)', async () => {
    const redis = makeFakeRedis();
    let currentMs = 0;
    const desiredOnline = 1000; // high threshold - one disconnect never crosses 20% alone
    const tracker = createOutageTracker({
      redis,
      env: 'test',
      getDesiredOnline: async () => desiredOnline,
      now: () => currentMs,
    });

    // One disconnect at minute 0.
    await tracker.noteDisconnect(503);
    const keysAtMinute0 = new Set(redis.buckets.keys());
    expect(keysAtMinute0.size).toBe(1);

    // Advance exactly 5 minutes (OUTAGE_BUCKET_COUNT) - the OLD `minute %
    // OUTAGE_BUCKET_COUNT` scheme would derive the SAME bucket key here,
    // silently adding this disconnect on top of minute 0's stale count. The
    // FIXED absolute-minute-stamp scheme must produce a genuinely NEW key.
    currentMs = 5 * 60_000;
    await tracker.noteDisconnect(503);
    const keysAtMinute5 = new Set(redis.buckets.keys());

    expect(keysAtMinute5.size).toBe(2); // two DISTINCT keys, never one collided key
    for (const key of keysAtMinute0) {
      expect(redis.buckets.get(key)).toBe(1); // minute 0's own count is untouched by minute 5's write
    }
  });
});
