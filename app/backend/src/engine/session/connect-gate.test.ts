import { describe, expect, it } from 'vitest';
import { createPerWorkerConnectGate } from './connect-gate.js';

/**
 * connect-gate.test.ts (P08 U5a) - unit proof of `createPerWorkerConnectGate`'s
 * in-process token bucket using a fully fake clock and a manually-driven
 * `setTimeoutFn` (no real timers, no sleeps - test-discipline). A burst of 5
 * immediate takes drains the bucket; the 6th queues and only resolves once
 * the fake clock + a manually-fired timer callback show enough elapsed time
 * for one token to refill at `ratePerSec`.
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
  fireNext(): void;
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
    fireNext: () => {
      const next = pending.shift();
      if (!next) {
        throw new Error('fireNext: no pending timer scheduled');
      }
      next.fn();
    },
    pendingCount: () => pending.length,
  };
}

describe('createPerWorkerConnectGate', () => {
  it('burst_of_five_is_immediate_sixth_waits_for_refill', async () => {
    const clock = makeFakeClock(0);
    const scheduler = makeFakeScheduler();
    const gate = createPerWorkerConnectGate({
      ratePerSec: 2,
      burst: 5,
      clock,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    const order: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await gate.take();
      order.push(i);
    }
    expect(order).toEqual([0, 1, 2, 3, 4]);

    let sixthResolved = false;
    const sixth = gate.take().then(() => {
      sixthResolved = true;
    });

    // The 6th taker must be queued behind a timer, not resolved synchronously.
    expect(sixthResolved).toBe(false);
    expect(scheduler.pendingCount()).toBeGreaterThan(0);

    // Refill at ratePerSec=2 means one token every 500ms - advance short of
    // that and firing the timer must NOT resolve the waiter yet.
    clock.advance(400);
    scheduler.fireNext();
    await Promise.resolve();
    expect(sixthResolved).toBe(false);

    // Advance past the 500ms mark; the gate re-arms its own timer chain, so
    // drain any additional scheduled timers until the waiter resolves.
    clock.advance(100);
    while (!sixthResolved && scheduler.pendingCount() > 0) {
      scheduler.fireNext();
      await Promise.resolve();
    }
    await sixth;
    expect(sixthResolved).toBe(true);
  });

  it('refill_is_continuous_not_bucketed_per_second', async () => {
    const clock = makeFakeClock(0);
    const scheduler = makeFakeScheduler();
    const gate = createPerWorkerConnectGate({
      ratePerSec: 2,
      burst: 1,
      clock,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    await gate.take();

    let secondResolved = false;
    const second = gate.take().then(() => {
      secondResolved = true;
    });
    expect(secondResolved).toBe(false);

    clock.advance(500);
    while (!secondResolved && scheduler.pendingCount() > 0) {
      scheduler.fireNext();
      await Promise.resolve();
    }
    await second;
    expect(secondResolved).toBe(true);
  });
});
