import { describe, expect, it, vi } from 'vitest';
import { createSessionOwner, createSessionRegistry, type RunnerHandle } from './registry.js';

/**
 * registry.test.ts (P08 U5a) - `createSessionOwner`'s two entry points:
 * `onFenceLost` tears down WITHOUT release, `close` ends the socket only.
 * Both are no-ops (never throw) for an instance not present in the registry
 * (a lease lost/closed for a handle this process never actually built -
 * fail-safe, never assume a handle that isn't there).
 */

function makeHandle(overrides: Partial<RunnerHandle> = {}): RunnerHandle {
  return {
    instanceId: 'inst-1',
    clientId: 'client-1',
    end: vi.fn(),
    teardownNoRelease: vi.fn().mockResolvedValue(undefined),
    teardownWithRelease: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('createSessionOwner', () => {
  it('on_fence_lost_tears_down_without_release', () => {
    const registry = createSessionRegistry();
    const handle = makeHandle();
    registry.set('inst-1', handle);
    const owner = createSessionOwner(registry);

    owner.onFenceLost('inst-1', 'watchdog');

    expect(handle.teardownNoRelease).toHaveBeenCalledTimes(1);
    expect(handle.teardownWithRelease).not.toHaveBeenCalled();
  });

  it('close_ends_the_socket_only', () => {
    const registry = createSessionRegistry();
    const handle = makeHandle();
    registry.set('inst-1', handle);
    const owner = createSessionOwner(registry);

    owner.close('inst-1');

    expect(handle.end).toHaveBeenCalledTimes(1);
    expect(handle.teardownNoRelease).not.toHaveBeenCalled();
    expect(handle.teardownWithRelease).not.toHaveBeenCalled();
  });

  it('missing_instance_is_a_safe_no_op_for_both_entry_points', () => {
    const registry = createSessionRegistry();
    const owner = createSessionOwner(registry);

    expect(() => owner.onFenceLost('missing', 'pg_fence_conflict')).not.toThrow();
    expect(() => owner.close('missing')).not.toThrow();
  });
});
