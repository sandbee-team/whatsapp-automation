import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRedis, resolveRedisUrl, sysKey } from '../../../platform/redis.js';
import { writeEpochCache } from '../token-epoch.js';

/**
 * token-epoch.integration.test.ts (P04a FIXC W1) - `writeEpochCache`'s
 * monotonic write, proven against a real Redis (same pattern as
 * platform/http/rate-limit.integration.test.ts). Before this fix, an
 * unconditional `SET` meant two racing post-commit writes could pin the
 * LOWER epoch in the cache for a full TTL if the higher one landed first.
 */

function uniqueEnv(): string {
  return `test-epoch-${randomUUID()}`;
}

describe('token-epoch (P04a FIXC W1, monotonic writeEpochCache)', () => {
  let redis: ReturnType<typeof createRedis> | undefined;
  let env = '';
  const userId = 'user-1';

  afterEach(async () => {
    if (redis) {
      try {
        await redis.del(sysKey(env, 'epoch', 'u', userId));
      } catch {
        // Best-effort cleanup only.
      }
    }
    redis?.disconnect();
    redis = undefined;
  });

  it('write_5_then_3_read_returns_5', async () => {
    redis = createRedis(resolveRedisUrl());
    env = uniqueEnv();

    await writeEpochCache({ redis, env, epochCacheTtlSec: 60 }, userId, 5);
    await writeEpochCache({ redis, env, epochCacheTtlSec: 60 }, userId, 3);

    const stored = await redis.get(sysKey(env, 'epoch', 'u', userId));
    expect(Number(stored)).toBe(5);
  });

  it('write_3_then_5_read_returns_5', async () => {
    redis = createRedis(resolveRedisUrl());
    env = uniqueEnv();

    await writeEpochCache({ redis, env, epochCacheTtlSec: 60 }, userId, 3);
    await writeEpochCache({ redis, env, epochCacheTtlSec: 60 }, userId, 5);

    const stored = await redis.get(sysKey(env, 'epoch', 'u', userId));
    expect(Number(stored)).toBe(5);
  });
});
