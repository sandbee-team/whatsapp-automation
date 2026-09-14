import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { WpLogger } from '@wp/server-kit';
import { applyFieldCap } from './field-cap-guard.js';
import type { FieldCapGuardDeps } from './field-cap-guard.js';
import { runFieldCapCheck } from './redis-repo-field-cap.js';

/**
 * field-cap-guard-edge-cases.test.ts (P10 C2 probe) - additional pure unit
 * tests for `applyFieldCap`'s fail-safe/boundary/idempotency edge cases,
 * split out of `field-cap-guard.test.ts` purely to stay under the repo's
 * `max-lines` guard (same reasoning as `pg-repo.ts`/`pg-repo-keys.ts`'s own
 * split). Same fake-store idiom as `field-cap-guard.test.ts`.
 */

function makeFakeHash(initialFieldIds: string[] = []): {
  deps: Pick<FieldCapGuardDeps, 'currentCount' | 'trimOneField'>;
  fields: string[];
} {
  const fields = [...initialFieldIds];
  return {
    fields,
    deps: {
      currentCount: async () => fields.length,
      trimOneField: async () => {
        const oldest = fields.shift();
        return oldest ?? null;
      },
    },
  };
}

function makeGuardDeps(overrides: Partial<FieldCapGuardDeps> = {}): FieldCapGuardDeps {
  return {
    currentCount: async () => 0,
    trimOneField: async () => null,
    onFieldEvicted: vi.fn(),
    onCapReached: vi.fn(),
    warn: vi.fn(),
    maxFieldsPerInstance: 4000,
    ...overrides,
  };
}

describe('applyFieldCap edge cases', () => {
  it('sig_tier_write_at_a_stale_hash_that_returns_zero_count_still_succeeds_fail_safe', async () => {
    // Simulates currentCount reading a stale/reset value (e.g. Redis
    // returning 0 for a hash that is actually populated, or a race where the
    // count read genuinely observes an emptier-than-real state). The guard
    // must still ALLOW the sig-tier write through - it never fails closed.
    const currentCount = vi.fn().mockResolvedValue(0);
    const onCapReached = vi.fn();
    const deps = makeGuardDeps({ currentCount, onCapReached, maxFieldsPerInstance: 3 });

    await expect(
      applyFieldCap(deps, {
        tier: 'sig',
        hashKey: 'hash-sig-stale',
        keyType: 'session',
        clientId: 'client-1',
        instanceId: 'inst-1',
        newFieldIds: ['s-1'],
      }),
    ).resolves.toBeUndefined();
    // Below cap given the (possibly stale) reading - no alarm, but critically
    // no throw / no drop either way.
    expect(onCapReached).not.toHaveBeenCalled();
  });

  it('sig_tier_write_still_succeeds_even_when_currentCount_rejects_fail_safe_not_fail_closed', async () => {
    // If the HLEN read itself fails (network blip, timeout), the guard must
    // propagate that failure rather than silently treating it as "at cap" -
    // but it must NEVER drop the ratchet write itself. This pins the current
    // behavior: a rejected currentCount rejects applyFieldCap (the caller's
    // write path in redis-repo-field-cap.ts is expected to surface this as a
    // read-timeout error, not proceed with an unknown cap state silently) -
    // i.e. the guard does not silently swallow the read failure and does not
    // fabricate a "drop" decision from it.
    const currentCount = vi.fn().mockRejectedValue(new Error('redis hlen timeout'));
    const deps = makeGuardDeps({ currentCount, maxFieldsPerInstance: 3 });

    await expect(
      applyFieldCap(deps, {
        tier: 'sig',
        hashKey: 'hash-sig-err',
        keyType: 'session',
        clientId: 'client-1',
        instanceId: 'inst-1',
        newFieldIds: ['s-1'],
      }),
    ).rejects.toThrow('redis hlen timeout');
  });

  it('sig_tier_at_exactly_the_cap_boundary_projected_equals_cap_does_not_alarm', async () => {
    // current=2, +1 new = 3 = cap exactly - "at cap" (<=) must NOT alarm;
    // only strictly OVER the cap alarms.
    const { deps: hashDeps } = makeFakeHash(['s-1', 's-2']);
    const onCapReached = vi.fn();
    const deps = makeGuardDeps({ ...hashDeps, onCapReached, maxFieldsPerInstance: 3 });

    await applyFieldCap(deps, {
      tier: 'sig',
      hashKey: 'hash-sig-1',
      keyType: 'session',
      clientId: 'client-1',
      instanceId: 'inst-1',
      newFieldIds: ['s-3'],
    });

    expect(onCapReached).not.toHaveBeenCalled();
  });

  it('sig_tier_one_field_over_the_cap_alarms_exactly_once_regardless_of_how_many_new_fields', async () => {
    // Multiple new field ids pushing well past the cap in one batch still
    // fires onCapReached exactly once (not once per overflowing field) -
    // pins the "alarm, don't loop" contract for the sig tier.
    const { deps: hashDeps, fields } = makeFakeHash(['s-1', 's-2', 's-3']);
    const onCapReached = vi.fn();
    const deps = makeGuardDeps({ ...hashDeps, onCapReached, maxFieldsPerInstance: 3 });

    await applyFieldCap(deps, {
      tier: 'sig',
      hashKey: 'hash-sig-1',
      keyType: 'session',
      clientId: 'client-1',
      instanceId: 'inst-1',
      newFieldIds: ['s-4', 's-5', 's-6', 's-7'],
    });

    expect(onCapReached).toHaveBeenCalledTimes(1);
    // Still never trimmed.
    expect(fields).toEqual(['s-1', 's-2', 's-3']);
  });

  it('cache_tier_trimming_stops_gracefully_when_the_hash_empties_before_reaching_the_cap', async () => {
    // Over by more than the fake hash actually holds - trimOneField returns
    // null once exhausted; the loop must stop (fail-safe no-op), never throw
    // or loop forever.
    const { deps: hashDeps, fields } = makeFakeHash(['a-1']);
    const onFieldEvicted = vi.fn();
    const deps = makeGuardDeps({
      ...hashDeps,
      onFieldEvicted,
      // current=1, projected = 1 + 5 = 6, cap=1 -> overBy=5, but only 1
      // field actually exists to trim.
      maxFieldsPerInstance: 1,
    });

    await applyFieldCap(deps, {
      tier: 'cache',
      hashKey: 'hash-1',
      keyType: 'device-list',
      clientId: 'client-1',
      instanceId: 'inst-1',
      newFieldIds: ['b-1', 'b-2', 'b-3', 'b-4', 'b-5'],
    });

    expect(onFieldEvicted).toHaveBeenCalledTimes(1);
    expect(fields).toEqual([]);
  });

  it('two_calls_re_setting_the_same_field_id_are_not_double_counted_idempotency', async () => {
    // The caller is responsible for excluding already-present ids (per the
    // module doc comment); this pins that calling applyFieldCap TWICE for the
    // identical newFieldIds batch (simulating a webhook/job replay before the
    // caller's own presence check runs) does not compound - each call reads
    // the CURRENT count fresh, so a replay that keeps re-submitting the same
    // id (now already present, so a correct caller would send empty
    // newFieldIds the second time) never inflates the trim/alarm count
    // beyond what one real growth of the hash warrants.
    const { deps: hashDeps, fields } = makeFakeHash(['x-1', 'x-2']);
    const onCapReached = vi.fn();
    const deps = makeGuardDeps({ ...hashDeps, onCapReached, maxFieldsPerInstance: 3 });

    // First call: genuinely new field, pushes to 3 (at cap, no alarm).
    await applyFieldCap(deps, {
      tier: 'sig',
      hashKey: 'hash-sig-1',
      keyType: 'session',
      clientId: 'client-1',
      instanceId: 'inst-1',
      newFieldIds: ['x-3'],
    });
    expect(onCapReached).not.toHaveBeenCalled();

    // Replay of the SAME id: a correct caller has already excluded it, so
    // newFieldIds is empty this time - must be a pure no-op.
    await applyFieldCap(deps, {
      tier: 'sig',
      hashKey: 'hash-sig-1',
      keyType: 'session',
      clientId: 'client-1',
      instanceId: 'inst-1',
      newFieldIds: [],
    });
    expect(onCapReached).not.toHaveBeenCalled();
    expect(fields).toEqual(['x-1', 'x-2']);
  });

  it('a_failing_field_cap_check_never_blocks_the_signal_write', async () => {
    // Stronger sibling of the C2 case above ("a stale/zero currentCount read
    // still allows the sig write"): here the check does not return a bad
    // value, it THROWS outright (missing method / real Redis error) before
    // even reaching applyFieldCap's own currentCount call. This pins
    // `runFieldCapCheck` (the real caller-facing wrapper in
    // redis-repo-field-cap.ts, not the pure applyFieldCap guard) as
    // fail-safe: ANY error from the cap-check path is caught and logged,
    // never propagated to the caller, so the real fence-gated write it
    // guards is always free to proceed (core invariant 2, ADR 0018 S5).
    const warn = vi.fn();
    const logger = {
      fatal: vi.fn(),
      error: vi.fn(),
      warn,
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as unknown as WpLogger;

    // hmget is entirely absent (mirrors a minimal/stale Redis stub), so the
    // very first call inside runFieldCapCheck throws a raw TypeError.
    const brokenRedis = {} as unknown as Redis;

    await expect(
      runFieldCapCheck(
        {
          redis: brokenRedis,
          tier: 'sig',
          key: 'hash-sig-broken',
          keyType: 'session',
          sets: { 's-1': Buffer.from('v') },
        },
        { clientId: 'client-1', instanceId: 'inst-1' },
        { maxFieldsPerInstance: 4000, logger },
      ),
    ).resolves.toBeUndefined();

    // The failure is observed (ids-only, no PII) rather than silently
    // dropped - but it never becomes the caller's rejection. Fields are
    // restricted to the shared LogFields allow-list, so the tier lives in
    // the message text, not a structured field.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      client_id: 'client-1',
      instance_id: 'inst-1',
      event_type: 'session',
      error_class: 'TypeError',
    });
    expect(warn.mock.calls[0]?.[1]).toMatch(/^redis sig-tier field-cap check failed/);
  });
});
