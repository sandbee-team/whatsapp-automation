import { describe, expect, it } from 'vitest';
import { runSendLoad, type SendLoadDriverDeps, type SendLoadPlanItem } from './send-load-driver.js';

/**
 * send-load-driver.test.ts (P26 U2b, step 2) - `runSendLoad`'s own unit test:
 * a fake clock/sleep (advance a shared counter, resolve immediately - zero
 * real waiting) and a constant `rng` of 0.5 (zero jitter, per this module's
 * own `nextDelayMs` doc comment), so every count below is EXACT, not a
 * bound. Does not reach `@wp/server-kit` (only `@wp/db`'s `createPool`,
 * which has no server-kit dependency - see `send-load-driver.ts`'s isMain
 * wiring), so no `stub-wp-server-kit-env` import is needed here.
 */

function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let clockMs = 0;
  return {
    now: () => clockMs,
    sleep: (ms: number) => {
      clockMs += ms;
      return Promise.resolve();
    },
  };
}

function constantRng(value: number): () => number {
  return () => value;
}

describe('send-load-driver', () => {
  it('every_instance_is_driven_at_its_own_interval', async () => {
    const plan: SendLoadPlanItem[] = [
      { clientId: 'c1', instanceId: 'i1', intervalMs: 1000, tenantKey: 'heavy' },
      { clientId: 'c2', instanceId: 'i2', intervalMs: 2000, tenantKey: 'medium' },
      { clientId: 'c3', instanceId: 'i3', intervalMs: 4000, tenantKey: 'small' },
    ];
    const { now, sleep } = fakeClock();
    const deps: SendLoadDriverDeps = { enqueue: async () => {}, now, sleep };

    const result = await runSendLoad(plan, deps, {
      durationMs: 8000,
      rng: constantRng(0.5),
    });

    // interval 1000 fires at t=1000,2000,...,8000 -> 8 sends.
    // interval 2000 fires at t=2000,4000,6000,8000 -> 4 sends.
    // interval 4000 fires at t=4000,8000 -> 2 sends.
    expect(result.perTenant.heavy).toBe(8);
    expect(result.perTenant.medium).toBe(4);
    expect(result.perTenant.small).toBe(2);
    expect(result.enqueued).toBe(14);
    expect(result.errors).toBe(0);
    expect(result.endedAtMs).toBe(8000);
  });

  it('a_burst_does_not_stop_the_steady_stream', async () => {
    const plan: SendLoadPlanItem[] = [
      { clientId: 'c1', instanceId: 'i1', intervalMs: 1000, tenantKey: 'heavy' },
    ];
    const { now, sleep } = fakeClock();
    const deps: SendLoadDriverDeps = { enqueue: async () => {}, now, sleep };

    const result = await runSendLoad(plan, deps, {
      durationMs: 4000,
      rng: constantRng(0.5),
      burst: {
        atMs: 2000,
        clientId: 'burst-client',
        instanceId: 'burst-instance',
        recipients: 100,
      },
    });

    expect(result.burstEnqueued).toBe(100);
    // Steady stream at interval 1000 over 4000ms: fires at 1000,2000,3000,4000 -> 4 sends.
    expect(result.perTenant.heavy).toBe(4);
    expect(result.enqueued).toBe(104);
  });

  it('an_enqueue_error_is_counted_and_the_run_continues', async () => {
    const plan: SendLoadPlanItem[] = [
      { clientId: 'c1', instanceId: 'i1', intervalMs: 1000, tenantKey: 'heavy' },
    ];
    const { now, sleep } = fakeClock();
    let calls = 0;
    const deps: SendLoadDriverDeps = {
      enqueue: async () => {
        calls += 1;
        if (calls % 5 === 0) {
          throw new Error('enqueue rejected');
        }
      },
      now,
      sleep,
    };

    const result = await runSendLoad(plan, deps, {
      durationMs: 10_000,
      rng: constantRng(0.5),
    });

    // interval 1000 over 10000ms fires 10 times; every 5th call (5th, 10th) rejects.
    expect(calls).toBe(10);
    expect(result.errors).toBe(2);
    expect(result.enqueued).toBe(8);
    expect(result.endedAtMs).toBe(10_000);
  });
});
