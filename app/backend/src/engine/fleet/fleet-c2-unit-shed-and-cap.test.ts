import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { readFleetCapacityHeadroom } from './discovery.js';
import { createSessionRegistry, type RunnerHandle } from '../session/registry.js';
import { buildShedPortsWithLeaseLookup } from '../session/fleet-adapters.js';
import type { SessionLease } from '../lease/lease-manager.js';
import { createFleetConnectGate, type CreateFleetConnectGateOptions } from './connect-budget.js';
import type { ConnectGate } from '../session/connect-gate.js';

/**
 * fleet-c2-unit-shed-and-cap.test.ts - C2 close-step probe (session-fleet-
 * and-drain, P09), split out of `fleet-c2-unit.test.ts` at FIX-P09-B for the
 * max-lines cap (topic split only - same cases, unchanged): shed victim
 * registry cleanup (case 5), readFleetCapacityHeadroom late-replay
 * staleness (case 3), and the fleet-bucket TIMEOUT-does-not-let-connect-
 * proceed case (case 2). See `fleet-c2-unit-counters.test.ts` for cases 4/7
 * and `fleet-c2-unit-reconcile-replay.test.ts` for case 1.
 */

// ---------------------------------------------------------------------
// Case 5 (retry storms / anti-churn) - shed_removes_the_registry_entry_so_
// the_worker_can_regrab_later: `fleet-adapters.ts`'s `endSocket` now calls
// `handle.teardownNoRelease()` (idempotent end + timer cleanup) THEN
// `registry.delete(instanceId)`, so the SAME worker's own grab-dedup check
// (`registry.has(instanceId)`, the exact predicate
// session-worker-composition.ts's `grab` callback uses) no longer treats a
// just-shed instance as still "owned" - it can be re-grabbed on a later
// scan, by this worker or another, instead of being silently orphaned.
// ---------------------------------------------------------------------
describe('C2 case 5 - shed victim registry cleanup (anti-churn / self-reacquire)', () => {
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

  it('shed_removes_the_registry_entry_so_the_worker_can_regrab_later', async () => {
    const registry = createSessionRegistry();
    const teardownNoRelease = vi.fn().mockResolvedValue(undefined);
    registry.set('inst-1', makeHandle({ instanceId: 'inst-1', teardownNoRelease }));

    const lease: SessionLease = {
      instanceId: 'inst-1',
      clientId: 'client-1',
      fence: 5n,
      workerId: 'w1',
      graceMs: 0,
    };
    const release = vi.fn().mockResolvedValue(undefined);
    const leaseManager = { release } as unknown as import('../lease/lease-manager.js').LeaseManager;

    const ports = buildShedPortsWithLeaseLookup(registry, leaseManager, (id) =>
      id === 'inst-1' ? lease : undefined,
    );

    // Execute the real shed sequence: endSocket then releaseLeaseGracefully -
    // exactly what shedVictims() does for a chosen victim.
    await ports.endSocket('inst-1');
    await ports.releaseLeaseGracefully('inst-1');

    expect(teardownNoRelease).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(lease);

    // The fix: the registry entry for the shed instance is gone.
    // session-worker-composition.ts's own `grab` callback short-circuits on
    // exactly this predicate:
    //   if (registry.has(row.instanceId)) { return true; }
    // With the entry removed, the SAME worker, seeing this now-unowned
    // instance reappear in its very next discovery scan, no longer reports
    // "already owned" trivially - it calls startDiscovered() again and can
    // re-acquire it (or another worker can).
    expect(registry.has('inst-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Case 3 - replay/staleness: a late replay of an OLD publishWorkerCap
// write, arriving AFTER a newer cap was already published for the same
// worker, must not resurrect a stale figure into fleet headroom.
// ---------------------------------------------------------------------
describe('C2 case 3 - readFleetCapacityHeadroom late-replay staleness', () => {
  it('an old cap write replayed after a newer one for the same worker does not get summed (last-write-wins by at, stale write pruned)', async () => {
    const store = new Map<string, string>();
    const hdelCalls: string[][] = [];
    const redis = {
      hgetall: vi.fn(async () => Object.fromEntries(store)),
      hset: vi.fn(async (_key: string, field: string, value: string) => {
        store.set(field, value);
        return 1;
      }),
      hdel: vi.fn(async (_key: string, ...fields: string[]) => {
        hdelCalls.push(fields);
        for (const f of fields) store.delete(f);
        return fields.length;
      }),
    } as unknown as import('ioredis').Redis;

    // Newer cap published first (at=2000), then an OLD/replayed write for
    // the SAME worker arrives with an EARLIER `at` (at=1000) but is applied
    // out of order - simulating a delayed/retried publish landing after a
    // fresher one already succeeded. Because publishWorkerCap does a plain
    // hset (last-write-wins on the FIELD), the stale replay would silently
    // overwrite the fresher value unless the caller guards against
    // out-of-order writes upstream - this test proves headroom accounting
    // itself does not additionally launder a stale `at` back into freshness
    // by re-summing an old timestamp as if it were current.
    store.set('worker-a', JSON.stringify({ cap: 50, at: 2000 }));
    // Directly simulate the late replay overwriting the field (this is
    // exactly what a second, out-of-order hset would do - the field-level
    // last-write-wins is Redis's own semantics, not this module's bug).
    store.set('worker-a', JSON.stringify({ cap: 5, at: 1000 }));

    // now() is far enough past `at=1000` that CAP_FRESHNESS_MS (30s) has
    // elapsed relative to that OLD timestamp, but NOT past 2000's freshness
    // window - proving the headroom reader keys freshness off the CURRENT
    // field content's own `at`, never off some remembered "last seen fresh"
    // state that could resurrect the newer number after it was clobbered.
    const headroom = await readFleetCapacityHeadroom({
      redis,
      env: 'test',
      desiredOnlineCount: 0,
      now: () => 1000 + 30_001,
    });

    // The stale replayed field (at=1000, now 30_001ms later) is correctly
    // pruned as stale - it must NOT be summed into headroom just because a
    // fresher write for the same worker existed a moment ago.
    expect(headroom).toBe(0 - 0);
    expect(hdelCalls.flat()).toContain('worker-a');
  });

  it('a worker entry with corrupt JSON is pruned as stale and does not zero out or throw for the rest of the fleet', async () => {
    const store = new Map<string, string>();
    store.set('worker-good', JSON.stringify({ cap: 40, at: 1000 }));
    store.set('worker-bad', '{not-json'); // corrupt field
    store.set('worker-good-2', JSON.stringify({ cap: 25, at: 1000 }));

    const hdelCalls: string[][] = [];
    const redis = {
      hgetall: vi.fn(async () => Object.fromEntries(store)),
      hdel: vi.fn(async (_key: string, ...fields: string[]) => {
        hdelCalls.push(fields);
        return fields.length;
      }),
    } as unknown as import('ioredis').Redis;

    const headroom = await readFleetCapacityHeadroom({
      redis,
      env: 'test',
      desiredOnlineCount: 10,
      now: () => 1000,
    });

    // 40 + 25 - 10 = 55 - the one corrupt entry is excluded, not treated as
    // 0 additional capacity AND not allowed to throw/abort the whole read.
    expect(headroom).toBe(55);
    expect(hdelCalls.flat()).toContain('worker-bad');
  });
});

// ---------------------------------------------------------------------
// Case 2 - slow-not-down: a fleet-bucket TIMEOUT (not a plain error) on
// take() must propagate and must NOT let connect proceed (fail-safe, no
// stampede). Proven at the createFleetConnectGate composition level -
// exactly the seam the real fleet ConnectGate uses.
// ---------------------------------------------------------------------
describe('C2 case 2 - fleet-bucket TIMEOUT on take() does not let connect proceed', () => {
  it('a rejected (timed-out) fleetBucket.take() propagates out of ConnectGate.take() rather than resolving - no stampede', async () => {
    const perWorkerGate: ConnectGate = { take: vi.fn().mockResolvedValue(undefined) };
    class FleetBucketTimeoutError extends Error {}
    const fleetBucket = {
      take: vi.fn().mockRejectedValue(new FleetBucketTimeoutError('take timed out after 2000ms')),
    };
    const onWait = vi.fn();
    const sleepMs = vi.fn().mockResolvedValue(undefined);

    const options: CreateFleetConnectGateOptions = { perWorkerGate, fleetBucket, onWait, sleepMs };
    const gate = createFleetConnectGate(options);

    await expect(gate.take()).rejects.toBeInstanceOf(FleetBucketTimeoutError);
    // The per-worker gate token WAS already spent (step 1 of take()) before
    // the fleet bucket timed out - but no retry loop absorbed the timeout
    // into a false "proceed" (sleepMs is never reached on a throw, since the
    // error is not caught inside the retry loop).
    expect(perWorkerGate.take).toHaveBeenCalledTimes(1);
    expect(sleepMs).not.toHaveBeenCalled();
    expect(onWait).not.toHaveBeenCalled();
  });
});
