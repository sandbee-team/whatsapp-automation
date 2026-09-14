import { describe, expect, it } from 'vitest';
import { computeConnectRatePerSec, instanceConnectOffsetMs, xxhash32 } from './connect-budget.js';

/**
 * connect-budget-rate.test.ts (P09 Unit U2 step 4, FIX-P09-B split) - the
 * connect-rate math and deterministic per-instance offset/hash cases, split
 * out of `connect-budget.test.ts` at FIX-P09-B for the max-lines cap (topic
 * split only - same cases, unchanged). No real Redis here (see
 * connect-budget.integration.test.ts for the real, fleet-wide proof across 3
 * simulated workers).
 */

describe('computeConnectRatePerSec', () => {
  it('connect_rate_clamps_between_8_and_40', () => {
    expect(computeConnectRatePerSec(1000)).toBe(8);
    expect(computeConnectRatePerSec(10000)).toBe(33);
    expect(computeConnectRatePerSec(25000)).toBe(40);
  });

  it('clamps_below_the_floor_and_above_the_ceiling', () => {
    expect(computeConnectRatePerSec(0)).toBe(8);
    expect(computeConnectRatePerSec(1)).toBe(8);
    expect(computeConnectRatePerSec(1_000_000)).toBe(40);
  });
});

describe('xxhash32 / instanceConnectOffsetMs', () => {
  it('per_instance_offset_is_deterministic_and_under_60s', () => {
    const idA = 'instance-aaaaaaaa-1111-2222-3333-444444444444';
    const idB = 'instance-bbbbbbbb-5555-6666-7777-888888888888';

    const offsetA1 = instanceConnectOffsetMs(idA);
    const offsetA2 = instanceConnectOffsetMs(idA);
    expect(offsetA1).toBe(offsetA2);
    expect(offsetA1).toBeGreaterThanOrEqual(0);
    expect(offsetA1).toBeLessThan(60_000);

    const offsetB = instanceConnectOffsetMs(idB);
    expect(offsetB).toBeGreaterThanOrEqual(0);
    expect(offsetB).toBeLessThan(60_000);

    // Spread over >=1000 ids is not clustered: every 6_000ms-wide decile
    // bucket (10 deciles across the 0..60_000 range) is non-empty.
    const deciles = new Array<number>(10).fill(0);
    for (let i = 0; i < 1000; i++) {
      const offset = instanceConnectOffsetMs(`instance-spread-${String(i)}`);
      const decile = Math.min(9, Math.floor(offset / 6000));
      deciles[decile] = (deciles[decile] ?? 0) + 1;
    }
    for (const count of deciles) {
      expect(count).toBeGreaterThan(0);
    }
  });

  it('xxhash32_is_a_pure_deterministic_hash_no_rng', () => {
    expect(xxhash32('')).toBe(xxhash32(''));
    expect(xxhash32('abc')).toBe(xxhash32('abc'));
    expect(xxhash32('abc')).not.toBe(xxhash32('abd'));
    // Known xxHash32 vector: seed 0, input "" -> 0x02CC5D05.
    expect(xxhash32('', 0)).toBe(0x02cc5d05);
  });
});
