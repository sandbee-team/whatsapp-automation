import { describe, expect, it, vi } from 'vitest';
import { applyFieldCap } from './field-cap-guard.js';
import type { FieldCapGuardDeps } from './field-cap-guard.js';

/**
 * field-cap-guard.test.ts (P10 Unit U5, step 6) - pure unit tests (fake
 * counters, no real Redis) for `applyFieldCap`'s two-tier semantics: the
 * REBUILDABLE tier trims oldest-first at the cap; the SIGNAL tier NEVER
 * trims (alarm + warn only, write always allowed) - ADR 0018 S5. Same
 * fake-store idiom as `bounded-key-store.test.ts` (an in-memory Map stands
 * in for the Redis hash instead of a real client).
 */

function makeFakeHash(initialFieldIds: string[] = []): {
  deps: Pick<FieldCapGuardDeps, 'currentCount' | 'trimOneField'>;
  fields: string[];
} {
  // Order = insertion order, so trimming index 0 is a genuine "oldest first"
  // trim, not a random pick.
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

describe('applyFieldCap', () => {
  it('rebuildable_tier_trims_oldest_field_at_the_cap', async () => {
    const { deps: hashDeps, fields } = makeFakeHash(['old-1', 'old-2', 'old-3']);
    const onFieldEvicted = vi.fn();
    const deps = makeGuardDeps({
      ...hashDeps,
      onFieldEvicted,
      maxFieldsPerInstance: 3,
    });

    await applyFieldCap(deps, {
      tier: 'cache',
      hashKey: 'hash-1',
      keyType: 'sender-key-memory',
      clientId: 'client-1',
      instanceId: 'inst-1',
      newFieldIds: ['new-1'],
    });

    // 3 existing + 1 new = 4, over the cap of 3 by 1 - the OLDEST field
    // ('old-1') is trimmed, never the newest.
    expect(onFieldEvicted).toHaveBeenCalledTimes(1);
    expect(fields).toEqual(['old-2', 'old-3']);
  });

  it('signal_tier_never_trims_and_only_warns_plus_increments_the_cap_reached_metric', async () => {
    const { deps: hashDeps, fields } = makeFakeHash(['s-1', 's-2', 's-3']);
    const onFieldEvicted = vi.fn();
    const onCapReached = vi.fn();
    const warn = vi.fn();
    const deps = makeGuardDeps({
      ...hashDeps,
      onFieldEvicted,
      onCapReached,
      warn,
      maxFieldsPerInstance: 3,
    });

    await applyFieldCap(deps, {
      tier: 'sig',
      hashKey: 'hash-sig-1',
      keyType: 'session',
      clientId: 'client-1',
      instanceId: 'inst-1',
      newFieldIds: ['s-4'],
    });

    // Never trimmed - all three original fields survive untouched.
    expect(onFieldEvicted).not.toHaveBeenCalled();
    expect(fields).toEqual(['s-1', 's-2', 's-3']);
    // Alarm fired exactly once, with ids only (no PII).
    expect(onCapReached).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({
      clientId: 'client-1',
      instanceId: 'inst-1',
      keyType: 'session',
    });
  });

  it('two_instances_are_isolated_one_instance_at_cap_does_not_affect_the_others_writes', async () => {
    // Instance A's hash is already at the cap.
    const instanceAHash = makeFakeHash(['a-1', 'a-2', 'a-3']);
    const onCapReachedA = vi.fn();
    const depsA = makeGuardDeps({
      ...instanceAHash.deps,
      onCapReached: onCapReachedA,
      maxFieldsPerInstance: 3,
    });

    // Instance B's hash is empty - a completely separate hashKey/counter.
    const instanceBHash = makeFakeHash([]);
    const onCapReachedB = vi.fn();
    const onFieldEvictedB = vi.fn();
    const depsB = makeGuardDeps({
      ...instanceBHash.deps,
      onCapReached: onCapReachedB,
      onFieldEvicted: onFieldEvictedB,
      maxFieldsPerInstance: 3,
    });

    await applyFieldCap(depsA, {
      tier: 'sig',
      hashKey: 'hash-sig-a',
      keyType: 'session',
      clientId: 'client-a',
      instanceId: 'inst-a',
      newFieldIds: ['a-4'],
    });
    expect(onCapReachedA).toHaveBeenCalledTimes(1);

    // Instance B, sharing nothing with A's counters, is nowhere near its own
    // cap and must see zero cap-reached/eviction activity.
    await applyFieldCap(depsB, {
      tier: 'sig',
      hashKey: 'hash-sig-b',
      keyType: 'session',
      clientId: 'client-b',
      instanceId: 'inst-b',
      newFieldIds: ['b-1'],
    });
    expect(onCapReachedB).not.toHaveBeenCalled();
    expect(onFieldEvictedB).not.toHaveBeenCalled();
  });

  it('replaying_an_already_present_field_id_is_not_counted_as_a_new_field_idempotency', async () => {
    // Idempotency (core invariant 3): the CALLER is responsible for excluding
    // already-present field ids from newFieldIds (see module doc comment) -
    // this test pins that an EMPTY newFieldIds batch (the shape a pure replay
    // reduces to) never triggers a cap check at all, regardless of how full
    // the hash already is.
    const currentCount = vi.fn().mockResolvedValue(4000);
    const onCapReached = vi.fn();
    const onFieldEvicted = vi.fn();
    const deps = makeGuardDeps({
      currentCount,
      onCapReached,
      onFieldEvicted,
      maxFieldsPerInstance: 4000,
    });

    await applyFieldCap(deps, {
      tier: 'sig',
      hashKey: 'hash-sig-1',
      keyType: 'session',
      clientId: 'client-1',
      instanceId: 'inst-1',
      newFieldIds: [],
    });

    expect(currentCount).not.toHaveBeenCalled();
    expect(onCapReached).not.toHaveBeenCalled();
    expect(onFieldEvicted).not.toHaveBeenCalled();
  });

  it('does_not_trim_or_warn_when_projected_count_stays_at_or_under_the_cap', async () => {
    const { deps: hashDeps, fields } = makeFakeHash(['x-1']);
    const onFieldEvicted = vi.fn();
    const onCapReached = vi.fn();
    const deps = makeGuardDeps({
      ...hashDeps,
      onFieldEvicted,
      onCapReached,
      maxFieldsPerInstance: 3,
    });

    await applyFieldCap(deps, {
      tier: 'cache',
      hashKey: 'hash-1',
      keyType: 'device-list',
      clientId: 'client-1',
      instanceId: 'inst-1',
      newFieldIds: ['x-2'],
    });

    expect(onFieldEvicted).not.toHaveBeenCalled();
    expect(fields).toEqual(['x-1']);

    await applyFieldCap(deps, {
      tier: 'sig',
      hashKey: 'hash-sig-1',
      keyType: 'session',
      clientId: 'client-1',
      instanceId: 'inst-1',
      newFieldIds: ['s-1'],
    });
    expect(onCapReached).not.toHaveBeenCalled();
  });
});
