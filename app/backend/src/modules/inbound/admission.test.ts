import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { tenantKey } from '../../platform/redis/keys.js';
import { bindInboundMetrics } from './metrics.js';
import { createInboundAdmission, type InboundBucketPort } from './admission.js';

/**
 * admission.test.ts (P21 Unit U5, step 6) - pure-logic proof of
 * `createInboundAdmission` against a fake `InboundBucketPort` that
 * implements the SAME token-bucket arithmetic as `inbound-bucket.lua`
 * in-memory, driven by an injected clock (no real Redis, no real timers -
 * the real-Redis proof lives in admission.integration.test.ts).
 */

/** In-memory mirror of inbound-bucket.lua's arithmetic, keyed by bucket key. */
function makeFakeBucket(): InboundBucketPort {
  const buckets = new Map<string, { tokens: number; ts: number }>();
  return {
    async take(
      key: string,
      capacity: number,
      refillPerMinute: number,
      nowMs: number,
    ): Promise<number> {
      const existing = buckets.get(key);
      let tokens: number;
      if (!existing) {
        tokens = capacity;
      } else {
        const elapsedMs = nowMs - existing.ts;
        tokens =
          elapsedMs > 0
            ? Math.min(capacity, existing.tokens + (elapsedMs * refillPerMinute) / 60_000)
            : existing.tokens;
      }
      if (tokens >= 1) {
        tokens -= 1;
        buckets.set(key, { tokens, ts: nowMs });
        return 1;
      }
      buckets.set(key, { tokens, ts: nowMs });
      return 0;
    },
  };
}

describe('createInboundAdmission', () => {
  it('an_event_above_the_ceiling_is_shed_and_counted', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const admission = createInboundAdmission({
      env: 'test',
      bucket: makeFakeBucket(),
      readLimit: async () => 5,
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => 0,
      metrics,
    });

    const decisions: string[] = [];
    for (let i = 0; i < 8; i++) {
      decisions.push(await admission.admit('client-1', 'instance-1'));
    }

    expect(decisions.filter((d) => d === 'admitted')).toHaveLength(5);
    expect(decisions.filter((d) => d === 'shed')).toHaveLength(3);
    expect((await metrics.inboundShedTotal.get()).values[0]?.value).toBe(3);
  });

  it('tokens_refill_at_the_per_minute_rate', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    let now = 0;
    const admission = createInboundAdmission({
      env: 'test',
      bucket: makeFakeBucket(),
      readLimit: async () => 5,
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => now,
      metrics,
    });

    // Drain the bucket of its 5 tokens at t=0.
    for (let i = 0; i < 5; i++) {
      expect(await admission.admit('client-1', 'instance-1')).toBe('admitted');
    }
    expect(await admission.admit('client-1', 'instance-1')).toBe('shed');

    // Advance 12s: limit 5/min => refill rate 1 token every 12s.
    now = 12_000;
    expect(await admission.admit('client-1', 'instance-1')).toBe('admitted');
    expect(await admission.admit('client-1', 'instance-1')).toBe('shed');
  });

  it('a_redis_error_fails_open_and_is_counted', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const bucket: InboundBucketPort = {
      take: vi.fn(async () => {
        throw new Error('redis unavailable');
      }),
    };
    const admission = createInboundAdmission({
      env: 'test',
      bucket,
      readLimit: async () => 5,
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => 0,
      metrics,
      logger: { warn: vi.fn() },
    });

    const decision = await admission.admit('client-1', 'instance-1');

    expect(decision).toBe('admitted');
    expect((await metrics.inboundAdmissionFailOpenTotal.get()).values[0]?.value).toBe(1);
    expect((await metrics.inboundShedTotal.get()).values[0]?.value).toBe(0);
  });

  it('the_limit_is_read_from_the_instance_and_cached_for_sixty_seconds', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    let now = 0;
    const readLimit = vi.fn(async () => 5);
    const admission = createInboundAdmission({
      env: 'test',
      bucket: makeFakeBucket(),
      readLimit,
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => now,
      metrics,
    });

    for (let i = 0; i < 100; i++) {
      now = i * 500; // 100 calls spread across 49.5s, well within 59s.
      await admission.admit('client-1', 'instance-1');
    }
    expect(readLimit).toHaveBeenCalledTimes(1);

    now = 60_001;
    await admission.admit('client-1', 'instance-1');
    expect(readLimit).toHaveBeenCalledTimes(2);

    // A null read falls back to defaults.maxPerMinute.
    const readLimitNull = vi.fn(async () => null);
    const admissionNull = createInboundAdmission({
      env: 'test',
      bucket: makeFakeBucket(),
      readLimit: readLimitNull,
      defaults: { maxPerMinute: 3, burst: 3 },
      clock: () => 0,
      metrics,
    });
    const decisions: string[] = [];
    for (let i = 0; i < 4; i++) {
      decisions.push(await admissionNull.admit('client-2', 'instance-2'));
    }
    expect(decisions).toEqual(['admitted', 'admitted', 'admitted', 'shed']);
  });

  it('two_instances_never_share_a_bucket_key', async () => {
    const takenKeys: string[] = [];
    const bucket: InboundBucketPort = {
      take: async (key: string) => {
        takenKeys.push(key);
        return 1;
      },
    };
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const admission = createInboundAdmission({
      env: 'test',
      bucket,
      readLimit: async () => 5,
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => 0,
      metrics,
    });

    await admission.admit('client-1', 'instance-a');
    await admission.admit('client-1', 'instance-b');
    await admission.admit('client-2', 'instance-a');

    expect(takenKeys).toEqual([
      tenantKey('test', 'client-1', 'inbound', 'i', 'instance-a'),
      tenantKey('test', 'client-1', 'inbound', 'i', 'instance-b'),
      tenantKey('test', 'client-2', 'inbound', 'i', 'instance-a'),
    ]);
  });
});
