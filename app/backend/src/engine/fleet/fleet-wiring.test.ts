import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { HeapBudgetMismatchError } from './budget.js';
import { bootWorkerBudget, createRedisOutagePort, wireFleetRuntime } from './fleet-wiring.js';
import type { ShedCandidate } from './shed.js';

/**
 * fleet-wiring.test.ts (P09 U6 step 9) - unit coverage for the pure/port
 * seams `fleet-wiring.ts` adds: `bootWorkerBudget` (both boot asserts run,
 * in order), `createRedisOutagePort` (the real INCR/EXPIRE-shaped port
 * against a fake ioredis-like client), and `wireFleetRuntime`'s sampler ->
 * admission/gauges fan-out plus the shed victimChooser wiring.
 */

describe('bootWorkerBudget', () => {
  it('derives the cap when the heap flag matches', () => {
    const result = bootWorkerBudget(
      { heapBudgetMb: 3072, processBaselineMb: 200, plannedSessionMb: 35, safetyFactor: 0.85 },
      ['--max-old-space-size=3072'],
      undefined,
    );
    expect(result.cap).toBe(69);
  });

  it('throws HeapBudgetMismatchError and never derives a cap on a mismatch', () => {
    expect(() =>
      bootWorkerBudget(
        { heapBudgetMb: 3072, processBaselineMb: 200, plannedSessionMb: 35, safetyFactor: 0.85 },
        ['--max-old-space-size=1024'],
        undefined,
      ),
    ).toThrow(HeapBudgetMismatchError);
  });
});

describe('createRedisOutagePort', () => {
  function fakeRedis() {
    const store = new Map<string, string>();
    return {
      store,
      incr: vi.fn(async (key: string) => {
        const next = (Number(store.get(key) ?? '0') + 1).toString();
        store.set(key, next);
        return Number(next);
      }),
      expire: vi.fn(async () => 1),
      mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    };
  }

  it('incrBucket increments and sets an expiry', async () => {
    const redis = fakeRedis();
    const port = createRedisOutagePort(redis as never);

    const first = await port.incrBucket('k1');
    const second = await port.incrBucket('k1');

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(redis.expire).toHaveBeenCalledTimes(2);
  });

  it('sumBuckets sums present keys and treats missing keys as 0', async () => {
    const redis = fakeRedis();
    const port = createRedisOutagePort(redis as never);
    await port.incrBucket('k1');
    await port.incrBucket('k1');
    await port.incrBucket('k2');

    const sum = await port.sumBuckets(['k1', 'k2', 'missing']);
    expect(sum).toBe(3);
  });

  it('sumBuckets returns 0 for an empty key list without calling mget', async () => {
    const redis = fakeRedis();
    const port = createRedisOutagePort(redis as never);
    const sum = await port.sumBuckets([]);
    expect(sum).toBe(0);
    expect(redis.mget).not.toHaveBeenCalled();
  });

  it('setFreezeFlag/isFreezeFlagSet round-trip', async () => {
    const redis = fakeRedis();
    const port = createRedisOutagePort(redis as never);

    expect(await port.isFreezeFlagSet('freeze')).toBe(false);
    await port.setFreezeFlag('freeze');
    expect(await port.isFreezeFlagSet('freeze')).toBe(true);
  });
});

describe('wireFleetRuntime', () => {
  it('sampleOnce feeds admission.onSample and the fleet gauges', () => {
    let sessions = 5;
    const runtime = wireFleetRuntime({
      getSessions: () => sessions,
      getCap: () => 100,
      budgetBytes: 1_000_000_000,
      getFleetHeadroom: () => 10,
      sessionInventory: { snapshot: () => [] },
      raiseCapacityAlert: vi.fn(),
      raiseThrashing: vi.fn(),
      monotonicNow: () => 0,
      samplerDeps: {
        readRssBytes: () => 100_000_000,
        readHeapOldSpaceBytes: () => 50_000_000,
        readEventLoopLagP99Ms: () => 5,
        readGcPauseP99Ms: () => 5,
      },
    });

    // Three samples to cross the admission trend window.
    runtime.sampleOnce();
    runtime.sampleOnce();
    runtime.sampleOnce();

    expect(runtime.admission.canAcceptLease().ok).toBe(true);
    sessions = 100;
    runtime.sampleOnce();
    runtime.sampleOnce();
    runtime.sampleOnce();
    expect(runtime.admission.canAcceptLease().ok).toBe(false);
  });

  it('chooseShedVictims delegates to shed.chooseShedVictims over the injected SessionInventory', () => {
    const candidates: ShedCandidate[] = [
      {
        instanceId: 'a',
        clientId: 'c1',
        acquiredAtMonotonic: 100,
        inFlightSendCount: 0,
        lastConversationActivityAtMonotonic: null,
        queueDepth: 0,
        pairingInProgress: false,
      },
      {
        instanceId: 'b',
        clientId: 'c1',
        acquiredAtMonotonic: 200,
        inFlightSendCount: 0,
        lastConversationActivityAtMonotonic: null,
        queueDepth: 0,
        pairingInProgress: false,
      },
    ];
    const runtime = wireFleetRuntime({
      getSessions: () => 0,
      getCap: () => 100,
      budgetBytes: 1_000_000_000,
      getFleetHeadroom: () => 10,
      sessionInventory: { snapshot: () => candidates },
      raiseCapacityAlert: vi.fn(),
      raiseThrashing: vi.fn(),
      monotonicNow: () => 1000,
    });

    // Most-recently-acquired first (b, acquiredAtMonotonic=200).
    expect(runtime.chooseShedVictims(1)).toEqual(['b']);
  });
});
