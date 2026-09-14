import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanupProbeClients } from '../../modules/instances/__tests__/instances-test-helpers.js';
import {
  makeClock,
  makeFakeSock,
  makeFakeTimerScheduler,
  pool,
  probeClientIds,
  seedProbe,
  buildRunner,
} from './runner-test-support.js';

/**
 * runner-connect-gate-abort.test.ts (FIX-P09-A, CRITICAL 3) - pins that
 * `runner.ts` creates a per-session `AbortController`, threads its signal
 * into `connectGate.take()`, and aborts it from `teardown()` (both
 * variants) alongside `clearPendingOffset()` - so a taker parked in the
 * fleet gate's unbounded retry loop (e.g. during a PROVIDER_OUTAGE freeze)
 * is promptly rejected instead of outliving the lease this worker already
 * released, and never proceeds to build a socket afterward.
 */

afterAll(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('createSessionRunner.start connect-gate abort on teardown (CRITICAL 3)', () => {
  it('teardownNoRelease aborts a parked connectGate.take() (fake timers, no real wait)', async () => {
    const { clientId, instanceId } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish = vi.fn();

    let capturedSignal: AbortSignal | undefined;
    let rejectTake: ((err: unknown) => void) | undefined;
    const take = vi.fn((opts?: { signal?: AbortSignal }) => {
      capturedSignal = opts?.signal;
      return new Promise<void>((_resolve, reject) => {
        rejectTake = reject;
        opts?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    });

    const { runner, instanceIdHolderSet, registry } = buildRunner({
      sock,
      fence: 1n,
      clock,
      scheduler,
      clientId,
      publish,
      connectGate: { take },
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });

    // take() was called and is parked (never resolved yet).
    expect(take).toHaveBeenCalledTimes(1);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    const handle = registry.get(instanceId);
    expect(handle).toBeDefined();
    await handle?.teardownNoRelease();

    // teardown must have aborted the signal - the parked take() is rejected.
    expect(capturedSignal?.aborted).toBe(true);
    void rejectTake;
  });

  it('an aborted taker never proceeds to socket build', async () => {
    const { clientId, instanceId } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish = vi.fn();

    const take = vi.fn(
      (opts?: { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );

    const { runner, instanceIdHolderSet, registry, socketFactory } = buildRunner({
      sock,
      fence: 1n,
      clock,
      scheduler,
      clientId,
      publish,
      connectGate: { take },
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });

    const handle = registry.get(instanceId);
    await handle?.teardownNoRelease();

    // Let the aborted take() rejection's .catch() branch in runner.ts settle.
    for (let i = 0; i < 200; i += 1) {
      await Promise.resolve();
    }

    expect(socketFactory).not.toHaveBeenCalled();
  });
});
