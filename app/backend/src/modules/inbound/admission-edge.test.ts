import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindInboundMetrics } from './metrics.js';
import { createInboundAdmission, type InboundBucketPort } from './admission.js';

/**
 * admission-edge.test.ts (P21 E3 hardening) - `readLimit` boundary values
 * (zero, negative, non-integer) beyond the sibling `admission.test.ts`
 * (which already covers null-falls-back-to-default, ceiling enforcement,
 * refill, fail-open, and per-instance key isolation). Fake bucket only - the
 * real-Lua clock-backwards and two-worker-sharing proofs live in
 * `admission-edge.integration.test.ts` (real Redis).
 */

function makeFakeBucket(): InboundBucketPort {
  const buckets = new Map<string, { tokens: number; ts: number }>();
  return {
    async take(key, capacity, refillPerMinute, nowMs): Promise<number> {
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

describe('createInboundAdmission readLimit boundary values', () => {
  it('a_readLimit_of_zero_falls_back_to_the_platform_default_not_a_zero_capacity_bucket', async () => {
    // FIXED: resolveLimit now has an independent floor
    // (`!Number.isInteger(v) || v < 1`) that catches non-positive-integer
    // values BEFORE they reach the bucket - `0` is not a positive integer,
    // so it falls back to `defaults.maxPerMinute`, is counted on
    // `wp_inbound_limit_fallback_total`, and admits normally (capacity 120,
    // not 0).
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const admission = createInboundAdmission({
      env: 'test',
      bucket: makeFakeBucket(),
      readLimit: async () => 0,
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => 0,
      metrics,
    });

    const decision = await admission.admit('client-1', 'instance-1');
    expect(decision).toBe('admitted');
    expect((await metrics.inboundLimitFallbackTotal.get()).values[0]?.value).toBe(1);
  });

  it('a_negative_readLimit_falls_back_to_the_platform_default_not_a_negative_capacity', async () => {
    // FIXED: -1 fails `Number.isInteger(v) && v >= 1`, so it falls back to
    // the default exactly like `0` above (a real negative value should
    // never be written by readInboundLimitFromDb given the migration's CHECK
    // constraint, but the admission layer now has its own defensive floor
    // regardless of what the DB enforces).
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const admission = createInboundAdmission({
      env: 'test',
      bucket: makeFakeBucket(),
      readLimit: async () => -1,
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => 0,
      metrics,
    });

    const decision = await admission.admit('client-1', 'instance-1');
    expect(decision).toBe('admitted');
    expect((await metrics.inboundLimitFallbackTotal.get()).values[0]?.value).toBe(1);
  });

  it('a_non_integer_readLimit_falls_back_to_the_platform_default_not_a_fractional_capacity', async () => {
    // FIXED: 2.5 fails `Number.isInteger(v)`, so it falls back to the
    // default (120) instead of being used as-is for capacity/refill - all 3
    // admits succeed (well under the 120 default), not just 2.
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const admission = createInboundAdmission({
      env: 'test',
      bucket: makeFakeBucket(),
      readLimit: async () => 2.5,
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => 0,
      metrics,
    });

    const decisions: string[] = [];
    for (let i = 0; i < 3; i++) {
      decisions.push(await admission.admit('client-1', 'instance-1'));
    }
    expect(decisions).toEqual(['admitted', 'admitted', 'admitted']);
    expect((await metrics.inboundLimitFallbackTotal.get()).values[0]?.value).toBe(1);
  });

  it('limit_of_exactly_one_admits_exactly_one_per_minute', async () => {
    let now = 0;
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const admission = createInboundAdmission({
      env: 'test',
      bucket: makeFakeBucket(),
      readLimit: async () => 1,
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => now,
      metrics,
    });

    expect(await admission.admit('client-1', 'instance-1')).toBe('admitted');
    expect(await admission.admit('client-1', 'instance-1')).toBe('shed');

    now = 59_999; // just under a minute later - still refilling toward 1, not yet there
    expect(await admission.admit('client-1', 'instance-1')).toBe('shed');

    now = 60_000; // exactly one minute after the single admit at t=0
    expect(await admission.admit('client-1', 'instance-1')).toBe('admitted');
  });

  it('a_readLimit_that_rejects_propagates_the_rejection_rather_than_falling_back', async () => {
    // resolveLimit awaits deps.readLimit directly with no try/catch of its
    // own - a rejecting readLimit propagates straight out of admit(),
    // documented here so a caller knows admit() is NOT automatically
    // fail-open against a THROWING readLimit (only a throwing bucket.take
    // is fail-open).
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const readLimit = vi.fn(async () => {
      throw new Error('db unavailable');
    });
    const admission = createInboundAdmission({
      env: 'test',
      bucket: makeFakeBucket(),
      readLimit,
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => 0,
      metrics,
    });

    await expect(admission.admit('client-1', 'instance-1')).rejects.toThrow('db unavailable');
  });
});
