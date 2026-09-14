import { afterAll, describe, expect, it, vi } from 'vitest';
import { instanceConnectOffsetMs } from '../fleet/connect-budget.js';
import { cleanupProbeClients } from '../../modules/instances/__tests__/instances-test-helpers.js';
import {
  makeClock,
  makeFakeSock,
  makeFakeTimerScheduler,
  pool,
  probeClientIds,
  seedProbe,
  buildRunner,
  type PublishMock,
} from './runner-test-support.js';

/**
 * runner-connect-offset.test.ts (P09 U6b) - the connect-STORM decorrelation
 * wait `runner.ts`'s `start()` runs between `readSessionEpoch` and the first
 * `buildAndWireSocket()` call: `instanceConnectOffsetMs(instanceId)`,
 * applied ONLY when `linkState === 'linked' && waveConnect`. Uses the SAME
 * `buildRunner`/`makeFakeTimerScheduler` machinery as
 * runner-reconnect.test.ts - the scheduler's `pendingCount()`/`fireAll()`
 * give deterministic, sleep-free control over the offset timer exactly like
 * every other runner timer in this suite.
 */

afterAll(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('createSessionRunner.start connect-stagger wait (P09 U6b)', () => {
  it('linked_instances_in_a_wave_connect_at_their_deterministic_offset', async () => {
    const { clientId, instanceId } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();

    const { runner, instanceIdHolderSet, socketFactory } = buildRunner({
      sock,
      fence: 1n,
      clock,
      scheduler,
      clientId,
      publish,
    });
    instanceIdHolderSet(instanceId);

    const expectedDelayMs = instanceConnectOffsetMs(instanceId);
    expect(expectedDelayMs).toBeGreaterThan(0);

    const startPromise = runner.start({
      instanceId,
      clientId,
      method: 'qr',
      waveConnect: true,
    });

    // readSessionEpoch is a real Postgres round trip - poll (no fixed sleep)
    // until the offset timer has actually been scheduled, then assert the
    // socket is still NOT built while it is pending.
    for (let i = 0; i < 200 && scheduler.pendingCount() === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(scheduler.pendingCount()).toBe(1);
    expect(socketFactory).not.toHaveBeenCalled();

    await scheduler.fireAll();
    await startPromise;

    expect(socketFactory).toHaveBeenCalledTimes(1);
  });

  it('pairing_instances_are_never_offset', async () => {
    const { clientId, instanceId } = await seedProbe({
      healthState: 'never_linked',
      linkState: 'pairing',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();

    const { runner, instanceIdHolderSet, socketFactory } = buildRunner({
      sock,
      fence: 1n,
      clock,
      scheduler,
      clientId,
      publish,
      instanceId,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({
      instanceId,
      clientId,
      method: 'qr',
      waveConnect: true,
    });

    // A 'pairing' instance connects immediately regardless of waveConnect -
    // zero offset timers scheduled (the socket build is now deferred behind
    // the connect-gate's own microtask hop - P09 fleet-recovery FIX - so
    // this polls briefly rather than asserting truly synchronous, but never
    // schedules a REAL timer either way).
    expect(scheduler.pendingCount()).toBe(0);
    for (let i = 0; i < 200 && socketFactory.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(socketFactory).toHaveBeenCalledTimes(1);
  });

  it('small_grabs_connect_immediately', async () => {
    const { clientId, instanceId } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();

    const { runner, instanceIdHolderSet, socketFactory } = buildRunner({
      sock,
      fence: 1n,
      clock,
      scheduler,
      clientId,
      publish,
    });
    instanceIdHolderSet(instanceId);

    // waveConnect: false (or omitted) - a linked instance still connects
    // with zero added delay outside a wave.
    await runner.start({ instanceId, clientId, method: 'qr' });

    // Socket build is deferred behind the connect-gate's own microtask hop
    // (P09 fleet-recovery FIX) - poll briefly rather than asserting truly
    // synchronous; zero REAL timer is scheduled either way.
    expect(scheduler.pendingCount()).toBe(0);
    for (let i = 0; i < 200 && socketFactory.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(socketFactory).toHaveBeenCalledTimes(1);
  });

  it('pending_offset_timers_are_cancelled_by_teardown_and_drain', async () => {
    const { clientId, instanceId } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();

    const { runner, instanceIdHolderSet, socketFactory, registry } = buildRunner({
      sock,
      fence: 1n,
      clock,
      scheduler,
      clientId,
      publish,
    });
    instanceIdHolderSet(instanceId);

    const startPromise = runner.start({
      instanceId,
      clientId,
      method: 'qr',
      waveConnect: true,
    });

    for (let i = 0; i < 200 && scheduler.pendingCount() === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(scheduler.pendingCount()).toBe(1);

    // Teardown races the pending offset wait (e.g. a drain/sweep tearing
    // this instance down before its deterministic offset elapses).
    const handle = registry.get(instanceId);
    expect(handle).toBeDefined();
    await handle?.teardownNoRelease();

    // start() must resolve (never hang on a timer that will now never
    // fire) without ever building a socket.
    await startPromise;
    expect(socketFactory).not.toHaveBeenCalled();

    // Firing whatever the fake scheduler still thinks is pending (if
    // anything) must not retroactively open a socket either.
    await scheduler.fireAll();
    expect(socketFactory).not.toHaveBeenCalled();
  });
});
