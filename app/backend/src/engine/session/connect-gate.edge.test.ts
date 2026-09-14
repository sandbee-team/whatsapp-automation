import { describe, expect, it } from 'vitest';
import { createPerWorkerConnectGate } from './connect-gate.js';

/**
 * connect-gate.edge.test.ts - E3 edge-case pass. `connect-gate.test.ts`
 * already proves a burst of 5 + a 6th queued waiter and continuous (not
 * per-second-bucketed) refill. This file adds: 20 CONCURRENT `take()` calls
 * resolving in strict FIFO order at the configured bucket rate on a fully
 * fake clock (no sleeps), and the documented behavior when there is no
 * cancellation mechanism at all - `ConnectGate.take()` has no `AbortSignal`
 * or cancel handle in its interface (see connect-gate.ts's own
 * `ConnectGate.take(): Promise<void>` - no cancel token), so "teardown while
 * queued" is pinned as: the queued promise is NEVER rejected/cancelled by
 * this module: it simply resolves whenever its turn comes, and the CALLER
 * (runner.ts's own `endSocketOnce`/teardown machinery) is responsible for
 * ignoring a stale resolution after a teardown - this module has no such
 * awareness itself.
 */

interface FakeClock {
  now(): number;
  advance(ms: number): void;
}

function makeFakeClock(start = 0): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface FakeScheduler {
  setTimeoutFn: (fn: () => void, ms: number) => number;
  /** Fires the SOONEST-scheduled pending timer, advancing `clock` by exactly its requested `ms` first (mirrors a real timer firing "on time", never early). Returns false if nothing is pending. */
  fireSoonest(clock: FakeClock): boolean;
  pendingCount(): number;
}

function makeFakeScheduler(): FakeScheduler {
  const pending: { fn: () => void; ms: number; id: number }[] = [];
  let nextId = 1;
  return {
    setTimeoutFn: (fn: () => void, ms: number) => {
      const id = nextId;
      nextId += 1;
      pending.push({ fn, ms, id });
      return id;
    },
    fireSoonest: (clock: FakeClock) => {
      if (pending.length === 0) return false;
      let soonestIdx = 0;
      for (let i = 1; i < pending.length; i += 1) {
        if ((pending[i]?.ms ?? Infinity) < (pending[soonestIdx]?.ms ?? Infinity)) {
          soonestIdx = i;
        }
      }
      const [entry] = pending.splice(soonestIdx, 1);
      if (!entry) return false;
      clock.advance(entry.ms);
      entry.fn();
      return true;
    },
    pendingCount: () => pending.length,
  };
}

describe('createPerWorkerConnectGate edge: contention', () => {
  it('20_concurrent_takes_resolve_strictly_fifo_at_the_bucket_rate', async () => {
    const clock = makeFakeClock(0);
    const scheduler = makeFakeScheduler();
    const gate = createPerWorkerConnectGate({
      ratePerSec: 2, // 1 token every 500ms
      burst: 5,
      clock,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    const resolvedOrder: number[] = [];
    const pendingTakes = Array.from({ length: 20 }, (_, i) =>
      gate.take().then(() => {
        resolvedOrder.push(i);
      }),
    );

    // Let the first burst of 5 resolve synchronously.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolvedOrder).toEqual([0, 1, 2, 3, 4]);

    // Fire the soonest-pending refill timer one at a time (advancing the
    // clock by exactly its own requested delay each time - never early,
    // never batched) until all 20 takers have resolved. Each individual
    // resolution must be the NEXT sequential index - strict FIFO, never a
    // later index jumping ahead of an earlier one.
    let guard = 0;
    while (resolvedOrder.length < 20 && guard < 200) {
      const fired = scheduler.fireSoonest(clock);
      if (!fired) break;
      await Promise.resolve();
      guard += 1;
    }

    await Promise.all(pendingTakes);
    expect(resolvedOrder).toHaveLength(20);
    expect(resolvedOrder).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('a_queued_taker_that_is_never_needed_again_is_simply_never_rejected_or_cancelled', async () => {
    // Documents the "no cancellation" contract: ConnectGate.take() returns a
    // bare Promise<void> with no reject path and no cancel handle. A caller
    // that tears down while queued must ignore a LATE resolution itself
    // (proven at the runner level, not here) - this module never throws.
    const clock = makeFakeClock(0);
    const scheduler = makeFakeScheduler();
    const gate = createPerWorkerConnectGate({
      ratePerSec: 2,
      burst: 1,
      clock,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    await gate.take(); // drains the single burst token

    let resolved = false;
    let rejected = false;
    const queued = gate.take().then(
      () => {
        resolved = true;
      },
      () => {
        rejected = true;
      },
    );

    // "Teardown" from the caller's perspective: nothing calls gate.take()
    // again and nothing observes `queued` further, but the promise chain
    // itself is left dangling exactly as a real "torn down before its turn"
    // waiter would be.
    expect(resolved).toBe(false);
    expect(rejected).toBe(false);

    scheduler.fireSoonest(clock);
    await queued;

    expect(resolved).toBe(true);
    expect(rejected).toBe(false);
  });
});
