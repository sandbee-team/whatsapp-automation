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
  type PublishMock,
} from './runner-test-support.js';

/**
 * runner-lease-grace-offset.test.ts (P09 fleet-recovery FIX) - pins the two
 * properties the fix must preserve, at the runner unit level (fake socket,
 * fake timer scheduler - no real 15s wait, deterministic via
 * `scheduler.fireAll()`):
 *
 *   1. `start()` never awaits `SessionLease.graceMs` inline - it returns a
 *      real handle (not `'not_acquired'`) BEFORE the grace timer fires, so a
 *      caller looping sequentially over many rows (`discovery.ts`'s own
 *      `for (const row of rows) { await grab(row); }`) is never blocked by
 *      one instance's grace wait. This is the exact serialization bug this
 *      fix resolves (see lease-manager.ts's own step 4 doc comment).
 *   2. The socket is never opened before the grace elapses on a
 *      non-graceful takeover (`graceMs > 0`) - `socketFactory` must show
 *      ZERO calls while the grace timer is still pending, and exactly ONE
 *      call once it fires.
 */

afterAll(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('createSessionRunner.start lease takeover grace (P09 fleet-recovery FIX)', () => {
  it('start_resolves_before_the_grace_elapses_never_serializing_a_sequential_caller', async () => {
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
      graceMs: 15_000,
    });
    instanceIdHolderSet(instanceId);

    // `start()` itself must settle (a real handle, not a hang) with ZERO
    // real wall-clock wait - this is the property that keeps
    // `discovery.ts`'s sequential grab loop from being blocked one grace
    // duration per row. A real bug here would make this `await` itself take
    // ~15s (or hang forever on a fake-timer-only scheduler that nothing
    // else ever advances); this test's own vitest timeout catches that.
    const handle = await runner.start({ instanceId, clientId, method: 'qr' });

    expect(handle).not.toBe('not_acquired');
    // The grace timer is scheduled but has not fired - socket must not be
    // open yet.
    expect(scheduler.pendingCount()).toBe(1);
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it('socket_never_opens_before_the_grace_elapses_on_a_non_graceful_takeover', async () => {
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
      graceMs: 15_000,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });

    // Still pending: socket must remain unopened.
    expect(scheduler.pendingCount()).toBe(1);
    expect(socketFactory).not.toHaveBeenCalled();

    // Fire the grace timer - the deferred open now proceeds.
    await scheduler.fireAll();
    // The fake authStore's `loadCreds` resolves on a microtask; poll briefly
    // (no fixed sleep) until the deferred `buildAndWireSocket()` call lands.
    for (let i = 0; i < 200 && socketFactory.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }

    expect(socketFactory).toHaveBeenCalledTimes(1);
  });

  it('grace_and_wave_connect_offset_compose_grace_first_then_offset', async () => {
    // A takeover (graceMs > 0) that ALSO lands in a wave-connect cycle: the
    // grace leg must elapse first (blueprint ordering: grace sits between
    // fence mint and socket open), then the wave-offset leg - never
    // concurrently collapsed into one wait, and never skipped for a
    // takeover.
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
      graceMs: 15_000,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr', waveConnect: true });

    // Leg 1 (grace) pending - the offset leg has not been scheduled yet.
    expect(scheduler.pendingCount()).toBe(1);
    expect(socketFactory).not.toHaveBeenCalled();

    // Fire leg 1 - leg 2 (wave offset) should now be scheduled instead of
    // the socket opening immediately.
    await scheduler.fireAll();
    for (let i = 0; i < 200 && scheduler.pendingCount() === 0; i += 1) {
      await Promise.resolve();
    }
    expect(scheduler.pendingCount()).toBe(1);
    expect(socketFactory).not.toHaveBeenCalled();

    // Fire leg 2 - the socket opens now.
    await scheduler.fireAll();
    for (let i = 0; i < 200 && socketFactory.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(socketFactory).toHaveBeenCalledTimes(1);
  });

  it('teardown_racing_the_grace_wait_cancels_it_and_never_opens_a_socket', async () => {
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
      graceMs: 15_000,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });
    expect(scheduler.pendingCount()).toBe(1);

    const handle = registry.get(instanceId);
    expect(handle).toBeDefined();
    await handle?.teardownNoRelease();

    // Firing whatever the fake scheduler still thinks is pending (if
    // anything) must not retroactively open a socket.
    await scheduler.fireAll();
    expect(socketFactory).not.toHaveBeenCalled();
  });
});
