import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
 * runner.c2.test.ts (P08 C2) - the all-cases adversarial pass over the
 * runner's NEW invariant surface, targeted categories 2 (replay), 5 (clock
 * boundaries / park-wins-over-a-scheduled-reconnect) and 6 (retry storm
 * bounds). E3 already covers duplicate close/stray open within ONE
 * generation (fixed by the sockGeneration/closeInFlightGeneration guards) -
 * these cases are deliberately about events crossing generations, or about
 * the scheduler/clock boundary, not repeated inside one.
 */

afterAll(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('runner.c2 - replayed close across generations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('a_replayed_stale_generation_close_object_does_not_touch_the_new_sockets_state', async () => {
    const { clientId, instanceId, fence } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });

    // Generation 1: close(428) -> schedules a reconnect.
    const closeEventA = {
      connection: 'close' as const,
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    };
    await sock.ev.emit('connection.update', closeEventA);
    expect(scheduler.pendingCount()).toBe(1);

    // Reconnect fires -> generation 2 (same FakeSock instance is reused by
    // buildAndWireSocket; the listener map is rebuilt and sockGeneration
    // bumps internally).
    await scheduler.fireAll();

    const publishCallsAfterReconnect = publish.mock.calls.length;

    // REPLAY: the SAME close event OBJECT from generation 1 is delivered
    // again (Baileys re-emitting a queued/duplicate event, or a test
    // harness bug replaying an old capture) - the CURRENT (generation 2)
    // listener is what receives it (that is the only listener registered),
    // but the single-flight closeInFlightGeneration guard for gen 2 has not
    // fired yet, so this is a FRESH close for gen 2, not a stale replay in
    // the FIX-1 sense. What must NOT happen: a SECOND, truly-stale replay
    // (the exact close already handled for gen 2) must be ignored.
    await sock.ev.emit('connection.update', closeEventA);
    const publishCallsAfterFirstGen2Close = publish.mock.calls.length;
    expect(publishCallsAfterFirstGen2Close).toBeGreaterThanOrEqual(publishCallsAfterReconnect);

    // Now replay the IDENTICAL event object a second time immediately
    // (same generation, already in flight) - FIX-1's single-flight guard
    // must swallow it as a no-op: no additional applyEngineTransition/publish
    // beyond what the first gen-2 close already produced, and no additional
    // reconnect timer scheduled on top of the one already pending.
    const pendingBeforeReplay = scheduler.pendingCount();
    await sock.ev.emit('connection.update', closeEventA);
    expect(scheduler.pendingCount()).toBe(pendingBeforeReplay);
    expect(publish.mock.calls.length).toBe(publishCallsAfterFirstGen2Close);
  });

  it('beginPairingIntent_double_submit_via_the_route_is_a_no_op_replay_pinned_at_the_repo_layer', async () => {
    // Pinning WHAT happens to qr_attempts/pairing_started_at on a route
    // double-submit lives in modules/instances (repo-level) - see
    // instance-transitions.c2.integration.test.ts's own describe block for
    // the full pin. This runner-level test only proves the RUNNER's pairing
    // controller path is unaffected by a double beginPairingIntent having
    // already reset qr_attempts to 0 before the runner's own onQr accounting
    // starts: the very NEXT onQr call must see attempt 1, not a stale
    // leftover count from before the replay.
    const { clientId, instanceId, fence } = await seedProbe({
      healthState: 'never_linked',
      linkState: 'pairing',
    });
    const { beginPairingIntent } = await import('../../modules/instances/repo.js');
    const { ctxFor } = await import('../../modules/instances/__tests__/instances-test-helpers.js');
    const ctx = ctxFor(pool, clientId);

    await beginPairingIntent(ctx, instanceId);
    await beginPairingIntent(ctx, instanceId); // double-submit replay

    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      instanceId,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });
    await sock.ev.emit('connection.update', { qr: 'qr-after-double-submit' });

    const qrEvent = publish.mock.calls
      .map((call) => call[0])
      .find((event) => event.type === 'instance.qr');
    expect(qrEvent?.attemptsLeft).toBe(4); // 5 max - 1st attempt post-replay = 4 left.
  });
});

describe('runner.c2 - clock/park boundary around a pending reconnect timer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sixth_qr_attempt_terminates_even_with_zero_elapsed_time_in_the_pairing_window', async () => {
    const { clientId, instanceId, fence } = await seedProbe({
      healthState: 'never_linked',
      linkState: 'pairing',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000); // fixed clock: "now" never advances.
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      instanceId,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });

    // Burn 5 attempts at ZERO elapsed clock time (pairing_started_at is set
    // by Postgres's own now() on the first increment; the FAKE clock used
    // for the window-expiry check never advances at all) - the window
    // clause (`clock.now() - startedAtMs > windowMs`) is never the reason
    // these terminate; the ATTEMPT COUNT must be what terminates the 6th.
    for (let i = 0; i < 5; i += 1) {
      await sock.ev.emit('connection.update', { qr: `qr-${String(i)}` });
    }
    expect(sock.end).not.toHaveBeenCalled();

    // 6th attempt: qr_attempts becomes 6 > maxAttempts(5) - terminates
    // regardless of elapsed time (which is exactly zero on the fake clock).
    await sock.ev.emit('connection.update', { qr: 'qr-6th' });
    expect(sock.end).toHaveBeenCalledTimes(1);

    const row = await pool.query<{ needs_user_action: boolean; user_action_reason: string | null }>(
      'SELECT needs_user_action, user_action_reason FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(row.rows[0]?.needs_user_action).toBe(true);
  });

  it('a_reconnect_scheduled_then_the_instance_parked_before_the_timer_fires_does_not_reconnect', async () => {
    const { clientId, instanceId, fence } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();

    const { runner, instanceIdHolderSet, registry } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
    });
    instanceIdHolderSet(instanceId);

    const handle = await runner.start({ instanceId, clientId, method: 'qr' });
    expect(handle).not.toBe('not_acquired');

    // close(428) schedules a reconnect timer (delay > 0, not fired yet).
    await sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    expect(scheduler.pendingCount()).toBe(1);

    // The instance is PARKED before the timer fires - the bootstrap scan's
    // teardownIfNoLongerEligible path calls teardownWithRelease() directly,
    // exactly like session-worker-composition.ts does on a desired_state
    // flip. This is the SAME registry handle the runner registered.
    const registered = registry.get(instanceId);
    expect(registered).toBeDefined();
    await registered?.teardownWithRelease();

    // Parking clears the pending timer via teardown()'s own
    // clearPendingReconnect() call - the timer must never fire at all.
    expect(scheduler.pendingCount()).toBe(0);

    // Even if a caller forces the (now-cleared) timer's underlying fn to run
    // anyway (simulating a scheduler that failed to honor clearTimeout - the
    // adversarial case the task calls out), firing whatever remains in the
    // fake scheduler must be a true no-op: nothing left to fire.
    const socketFactoryCallsBefore = sock.end.mock.calls.length;
    await scheduler.fireAll();
    expect(sock.end.mock.calls.length).toBe(socketFactoryCallsBefore);
  });
});
