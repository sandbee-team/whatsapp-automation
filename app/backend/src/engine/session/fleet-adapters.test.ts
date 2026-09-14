import { describe, expect, it, vi } from 'vitest';
import { createSessionRegistry, type RunnerHandle } from './registry.js';
import type { SessionLease } from '../lease/lease-manager.js';
import {
  buildSessionInventory,
  buildShedPortsWithLeaseLookup,
  buildDrainSessions,
  buildEmptyInFlightPort,
} from './fleet-adapters.js';

/**
 * fleet-adapters.test.ts (P09 U6 step 9) - the real registry-backed ports
 * `engine/fleet/**`'s pure modules consume: `SessionInventory` (shed
 * selection input), `ShedPorts` (shed execution), `DrainSession[]` (SIGTERM
 * drain). All against a fake `SessionRunnerRegistry`/`LeaseManager` - no
 * real socket or Postgres involved (that is
 * `session-worker-composition`-level integration coverage).
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

describe('buildSessionInventory', () => {
  it('projects a ShedCandidate for every handle that implements inventorySnapshot', () => {
    const registry = createSessionRegistry();
    registry.set(
      'inst-1',
      makeHandle({
        instanceId: 'inst-1',
        clientId: 'client-a',
        inventorySnapshot: () => ({
          acquiredAtMonotonic: 100,
          inFlightSendCount: 0,
          lastConversationActivityAtMonotonic: null,
          queueDepth: 2,
          pairingInProgress: false,
        }),
      }),
    );

    const inventory = buildSessionInventory(registry);
    const snapshot = inventory.snapshot();

    expect(snapshot).toEqual([
      {
        instanceId: 'inst-1',
        clientId: 'client-a',
        acquiredAtMonotonic: 100,
        inFlightSendCount: 0,
        lastConversationActivityAtMonotonic: null,
        queueDepth: 2,
        pairingInProgress: false,
      },
    ]);
  });

  it('skips a handle with no inventorySnapshot rather than fabricating one', () => {
    const registry = createSessionRegistry();
    registry.set('inst-1', makeHandle({ instanceId: 'inst-1' }));

    const inventory = buildSessionInventory(registry);
    expect(inventory.snapshot()).toEqual([]);
  });
});

describe('buildShedPortsWithLeaseLookup', () => {
  it('endSocket tears down without release and releaseLeaseGracefully releases the resolved lease', async () => {
    const registry = createSessionRegistry();
    const teardownNoRelease = vi.fn().mockResolvedValue(undefined);
    registry.set('inst-1', makeHandle({ instanceId: 'inst-1', teardownNoRelease }));

    const lease: SessionLease = {
      instanceId: 'inst-1',
      clientId: 'client-a',
      fence: 5n,
      workerId: 'w1',
      graceMs: 0,
    };
    const release = vi.fn().mockResolvedValue(undefined);
    const leaseManager = { release } as unknown as import('../lease/lease-manager.js').LeaseManager;

    const ports = buildShedPortsWithLeaseLookup(registry, leaseManager, (id) =>
      id === 'inst-1' ? lease : undefined,
    );

    await ports.endSocket('inst-1');
    expect(teardownNoRelease).toHaveBeenCalledTimes(1);

    await ports.releaseLeaseGracefully('inst-1');
    expect(release).toHaveBeenCalledWith(lease);
  });

  it('both legs are safe no-ops for a handle/lease that is no longer present', async () => {
    const registry = createSessionRegistry();
    const release = vi.fn().mockResolvedValue(undefined);
    const leaseManager = { release } as unknown as import('../lease/lease-manager.js').LeaseManager;
    const ports = buildShedPortsWithLeaseLookup(registry, leaseManager, () => undefined);

    await expect(ports.endSocket('gone')).resolves.toBeUndefined();
    await expect(ports.releaseLeaseGracefully('gone')).resolves.toBeUndefined();
    expect(release).not.toHaveBeenCalled();
  });

  it('shed_removes_the_registry_entry_so_the_worker_can_regrab_later (C2 pinning, adapter-level)', async () => {
    const registry = createSessionRegistry();
    registry.set('inst-1', makeHandle({ instanceId: 'inst-1' }));

    const lease: SessionLease = {
      instanceId: 'inst-1',
      clientId: 'client-a',
      fence: 5n,
      workerId: 'w1',
      graceMs: 0,
    };
    const release = vi.fn().mockResolvedValue(undefined);
    const leaseManager = { release } as unknown as import('../lease/lease-manager.js').LeaseManager;

    const ports = buildShedPortsWithLeaseLookup(registry, leaseManager, (id) =>
      id === 'inst-1' ? lease : undefined,
    );

    await ports.endSocket('inst-1');
    await ports.releaseLeaseGracefully('inst-1');

    expect(registry.has('inst-1')).toBe(false);
  });
});

describe('buildDrainSessions', () => {
  it('builds one DrainSession per held handle, wired to flushCredsFor/teardownNoRelease/release', async () => {
    const registry = createSessionRegistry();
    const teardownNoRelease = vi.fn().mockResolvedValue(undefined);
    registry.set(
      'inst-1',
      makeHandle({ instanceId: 'inst-1', clientId: 'client-a', teardownNoRelease }),
    );

    const lease: SessionLease = {
      instanceId: 'inst-1',
      clientId: 'client-a',
      fence: 5n,
      workerId: 'w1',
      graceMs: 0,
    };
    const release = vi.fn().mockResolvedValue(undefined);
    const leaseManager = { release } as unknown as import('../lease/lease-manager.js').LeaseManager;
    const flushCredsFor = vi.fn().mockResolvedValue(undefined);

    const sessions = buildDrainSessions(registry, leaseManager, () => lease, flushCredsFor);
    expect(sessions).toHaveLength(1);

    const session = sessions[0]!;
    expect(session.instanceId).toBe('inst-1');
    await session.flushCreds();
    expect(flushCredsFor).toHaveBeenCalledWith('inst-1');

    session.endSocket();
    expect(teardownNoRelease).toHaveBeenCalledTimes(1);

    await session.releaseLease();
    expect(release).toHaveBeenCalledWith(lease);
  });

  it('CRITICAL 1 pinning: endSocket tears down (cancelling any pending deferred chain) BEFORE releaseLease runs, so no rebuild can race the drain release', async () => {
    // Simulates the exact hazard: a parked deferred-open chain that, once
    // teardownNoRelease flips tornDown, must never proceed to rebuild a
    // socket - even though releaseLease (a completely separate call) runs
    // straight after.
    const registry = createSessionRegistry();
    let tornDown = false;
    let socketBuiltAfterTeardown = false;

    const teardownNoRelease = vi.fn(async () => {
      tornDown = true;
    });
    registry.set(
      'inst-1',
      makeHandle({ instanceId: 'inst-1', clientId: 'client-a', teardownNoRelease }),
    );

    const lease: SessionLease = {
      instanceId: 'inst-1',
      clientId: 'client-a',
      fence: 5n,
      workerId: 'w1',
      graceMs: 0,
    };
    const release = vi.fn().mockResolvedValue(undefined);
    const leaseManager = { release } as unknown as import('../lease/lease-manager.js').LeaseManager;
    const flushCredsFor = vi.fn().mockResolvedValue(undefined);

    const sessions = buildDrainSessions(registry, leaseManager, () => lease, flushCredsFor);
    const session = sessions[0]!;

    // A pending deferred chain (grace/offset wait, or an in-flight reconnect
    // timer) that resolves AFTER drain's endSocket - it must observe
    // tornDown === true and refuse to build a socket.
    async function deferredChainRace(): Promise<void> {
      await Promise.resolve();
      if (tornDown) return;
      socketBuiltAfterTeardown = true;
    }
    const raceHandle = deferredChainRace();

    session.endSocket();
    await raceHandle;
    expect(tornDown).toBe(true);
    expect(socketBuiltAfterTeardown).toBe(false);

    await session.releaseLease();
    expect(release).toHaveBeenCalledWith(lease);
    // teardown ran strictly before release - proven by tornDown already
    // being true when releaseLease is invoked.
    expect(teardownNoRelease).toHaveBeenCalledTimes(1);
  });
});

describe('buildEmptyInFlightPort', () => {
  it('lists nothing and resolves quiescence immediately (P11 stub)', async () => {
    const port = buildEmptyInFlightPort();
    expect(port.list()).toEqual([]);
    await expect(port.awaitQuiescence(20_000)).resolves.toBeUndefined();
  });
});
