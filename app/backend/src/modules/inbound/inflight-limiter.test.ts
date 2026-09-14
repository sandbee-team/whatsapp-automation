import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindInboundMetrics } from './metrics.js';
import { createInflightLimiter } from './inflight-limiter.js';

/**
 * inflight-limiter.test.ts (P21 C1 fix round) - the per-worker bounded
 * in-flight limiter guarding `session-worker-inbound-wiring.ts`'s socket
 * handlers from launching an unbounded number of concurrent `withTenant`
 * chains on a load spike (reviewer MAJOR finding). Deterministic only:
 * every task is a manually-resolved deferred, never a real timer/sleep.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createInflightLimiter', () => {
  it('slots_then_queue_then_counted_drop', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const warn = vi.fn();
    const limiter = createInflightLimiter({
      maxInFlight: 2,
      maxPending: 1,
      metrics,
      logger: { warn },
    });

    const tasks = Array.from({ length: 5 }, () => deferred<void>());
    const invoked: boolean[] = [false, false, false, false, false];
    const results = tasks.map((d, i) =>
      limiter.run('message', () => {
        invoked[i] = true;
        return d.promise;
      }),
    );

    expect(results).toEqual(['started', 'started', 'queued', 'dropped', 'dropped']);
    expect(invoked).toEqual([true, true, false, false, false]);
    expect(limiter.inFlight()).toBe(2);
    expect(limiter.pending()).toBe(1);

    const values = (await metrics.inboundOverflowTotal.get()).values;
    expect(values.find((v) => v.labels.kind === 'message')?.value).toBe(2);

    // Resolving the first started task frees a slot; the queued (3rd) task
    // starts next (FIFO), in-flight stays at 2, pending drops to 0.
    tasks[0]!.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(invoked[2]).toBe(true);
    expect(limiter.inFlight()).toBe(2);
    expect(limiter.pending()).toBe(0);

    // Drain the rest so the test leaves no dangling handles.
    tasks[1]!.resolve();
    tasks[2]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(limiter.inFlight()).toBe(0);
  });

  it('a_rejecting_task_releases_its_slot_and_is_logged_name_only', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const warn = vi.fn();
    const limiter = createInflightLimiter({
      maxInFlight: 1,
      maxPending: 5,
      metrics,
      logger: { warn },
    });

    const result = limiter.run('receipt', () => Promise.reject(new Error('boom - has a message')));
    expect(result).toBe('started');
    expect(limiter.inFlight()).toBe(1);

    // Let the rejection's .catch handler run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(limiter.inFlight()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    const loggedObj = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(loggedObj).not.toHaveProperty('message');
    expect(JSON.stringify(loggedObj)).not.toContain('has a message');
  });

  it('overflow_never_runs_the_task', () => {
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const limiter = createInflightLimiter({
      maxInFlight: 0,
      maxPending: 0,
      metrics,
      logger: { warn: vi.fn() },
    });

    const task = vi.fn(() => Promise.resolve());
    const result = limiter.run('message', task);

    expect(result).toBe('dropped');
    expect(task).not.toHaveBeenCalled();
  });
});
