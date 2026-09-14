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
 * runner-disconnect.edge.integration.test.ts - E3 edge-case pass (P08
 * session-qr-linking). Two runner-level double-event scenarios Baileys is
 * documented to be able to produce, neither covered by runner.test.ts /
 * runner-reconnect.test.ts: (1) two 'close' events fired in quick succession
 * for the SAME underlying disconnect, and (2) an 'open' event arriving AFTER
 * the pairing-exhaustion teardown has already run.
 *
 * BOTH cases surfaced a REAL bug rather than confirming the desired
 * behavior - see the FINDING comments on each test below and the top-level
 * report. `onConnectionUpdate` (runner.ts) has NO reentrancy guard on either
 * branch: a second 'close' re-runs the full side-effect + audit-write path
 * a second time (double audit row), and a stray 'open' after teardown calls
 * `markLinkedConnected` uncaught, so the storage layer's own
 * `StateWriteLostFenceError` propagates out of the socket event handler
 * instead of being handled/ignored by the runner.
 */

afterAll(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('runner double-event edge cases', () => {
  it('two_close_events_in_quick_succession_run_teardown_side_effects_once', async () => {
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

    // A 403 (restriction) is a terminal, non-reconnecting outcome - the
    // clearest signal if a side effect (audit row / lease release) ran
    // twice, since nothing else touches this row again afterwards.
    const closeEvent = {
      connection: 'close' as const,
      lastDisconnect: { error: { output: { statusCode: 403 } } },
    };

    // Baileys can re-emit 'close' - fire it twice back-to-back, exactly as
    // the raw event stream might, with no await gap engineered between them.
    const firstClose = sock.ev.emit('connection.update', closeEvent);
    const secondClose = sock.ev.emit('connection.update', closeEvent);
    await Promise.all([firstClose, secondClose]);

    // FIXED (P08 E3 FIX 1): `onConnectionUpdate`'s 'close' branch now has a
    // single-flight guard keyed on the current socket generation - a second
    // close event for the SAME generation is ignored. One underlying
    // disconnect => exactly one audit row.
    const audit = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
        WHERE client_id = $1 AND target_id = $2 AND action = 'instance.paused'`,
      [clientId, instanceId],
    );
    expect(audit.rows[0]?.count).toBe('1');

    // The row's FINAL state still reads correctly (both writes agree on the
    // same content) - the bug is a duplicated SIDE EFFECT (audit row), not a
    // corrupted final state.
    const row = await pool.query<{ health_state: string; user_action_reason: string | null }>(
      'SELECT health_state, user_action_reason FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(row.rows[0]?.health_state).toBe('paused');
    expect(row.rows[0]?.user_action_reason).toBe('RESTRICTION_SIGNAL');

    // No reconnect was scheduled by either close (403 never auto-reconnects).
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('an_open_event_arriving_after_pairing_exhaustion_tore_down_is_ignored_safely', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
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

    // Exhaust the 5-attempt pairing budget (the 6th call tears down with
    // release - see pairing.ts/runner.test.ts's own sixth_qr_attempt case).
    for (let i = 0; i < 6; i += 1) {
      await sock.ev.emit('connection.update', { qr: `qr-${String(i)}` });
    }

    // Confirm the lease was actually released before proceeding - the
    // precondition this test needs to be meaningful.
    const leaseBefore = await pool.query<{ released_at: Date | null }>(
      'SELECT released_at FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(leaseBefore.rows[0]?.released_at).not.toBeNull();

    // FIXED (P08 E3 FIX 2): a stray 'open' arrives on the SAME
    // (already-ended) fake socket after teardown. `onOpen`/
    // `onConnectionUpdate` are now guarded behind the ended/fenced flag and
    // wrap the write in a try/catch: a `StateWriteLostFenceError` (or the
    // ended-runner state) is caught and treated as a safe no-op - logged as
    // a warn, never resurrecting state, never rethrown out of the socket
    // callback. The emit resolves cleanly with no unhandled rejection.
    sock.user = { id: '15550009999:1@s.whatsapp.net' };
    await expect(
      sock.ev.emit('connection.update', { connection: 'open' }),
    ).resolves.toBeUndefined();

    const row = await pool.query<{ link_state: string; health_state: string }>(
      'SELECT link_state, health_state FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    // Still whatever pairing-expired left it as (unlinked/never_linked) -
    // NOT connected/linked: the storage-layer fence guard is what actually
    // protects the row here, not any runner-level check.
    expect(row.rows[0]?.link_state).toBe('unlinked');
    expect(row.rows[0]?.health_state).toBe('never_linked');

    const leaseAfter = await pool.query<{ released_at: Date | null }>(
      'SELECT released_at FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(leaseAfter.rows[0]?.released_at?.toISOString()).toBe(
      leaseBefore.rows[0]?.released_at?.toISOString(),
    );
  });

  it('a_440_expected_takeover_close_calls_sock_end_exactly_once', async () => {
    const { clientId, instanceId, fence } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const expectedTakeoverCheck = vi.fn().mockResolvedValue(true);

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      expectedTakeoverCheck,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });

    // FIX (A3): the 'end_socket' side effect used to set state.ended = true
    // directly, bypassing endSocketOnce - the registry handle's own end()
    // (which owns the flag) would then no-op on the LATER call, and the
    // underlying FakeableSocket's `.end()` was never actually invoked. The
    // real Baileys socket would leak on this expected-takeover path.
    await sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 440 } } },
    });

    expect(expectedTakeoverCheck).toHaveBeenCalledTimes(1);
    expect(sock.end).toHaveBeenCalledTimes(1);
  });

  it('a_teardown_racing_the_reconnect_timer_arm_window_leaves_no_reconnect_attempt', async () => {
    const { clientId, instanceId, fence } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();

    const { runner, instanceIdHolderSet, registry, socketFactory } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });
    const handle = registry.get(instanceId);
    expect(handle).toBeDefined();
    // P09 fleet-recovery FIX: the first socket build is now deferred behind
    // the connect-gate's own microtask hop (even a fully-resolved fake
    // `connectGate.take()` costs one) - poll briefly for it to land before
    // capturing the "before" count, so this count reflects the FIRST
    // socket, not a not-yet-built one.
    for (let i = 0; i < 200 && socketFactory.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    const socketFactoryCallsBeforeClose = socketFactory.mock.calls.length;
    expect(socketFactoryCallsBeforeClose).toBe(1);

    // FIX (A5): a 428 close begins handling (schedules a reconnect timer at
    // the end of its own async continuation); a CONCURRENT teardownNoRelease
    // call (simulating e.g. a Redis-only fence loss racing this same close)
    // fires in the same microtask window. Before the FIX, teardown's own
    // clearPendingReconnect() could run BEFORE the timer field was even
    // assigned, clearing nothing - the timer would still fire later and
    // rebuild a socket on the now-lost fence. The FIX makes the timer
    // callback itself check state.ended/tornDown before doing anything.
    await Promise.all([
      sock.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 428 } } },
      }),
      handle?.teardownNoRelease(),
    ]);

    await scheduler.fireAll();

    // No reconnect attempt actually rebuilt the socket - firing whatever
    // timer (if any) remained pending is a true no-op.
    expect(socketFactory.mock.calls.length).toBe(socketFactoryCallsBeforeClose);
    expect(registry.get(instanceId)).toBeUndefined();
  });
});
