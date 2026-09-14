import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanupProbeClients } from '../../modules/instances/__tests__/instances-test-helpers.js';
import { bindSessionMetrics } from './metrics.js';
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
 * runner-reconnect.test.ts (P08 U5a) - the `close` handling / reconnect-
 * scheduling named test cases, split out of runner.test.ts purely to keep
 * both suites under max-lines (see runner-test-support.ts for the shared
 * fake-socket/fake-scheduler machinery).
 */

afterAll(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('createSessionRunner.start reconnect scheduling', () => {
  it('close_428_schedules_one_reconnect_through_the_gate', async () => {
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

    await sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });

    expect(scheduler.pendingCount()).toBe(1);
  });

  it('a_scheduled_reconnect_increments_wp_reconnect_attempts_total', async () => {
    const { clientId, instanceId, fence } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    const sock = makeFakeSock();
    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock: makeClock(1_000),
      scheduler: makeFakeTimerScheduler(),
      clientId,
      publish: vi.fn() as PublishMock,
    });
    instanceIdHolderSet(instanceId);
    await runner.start({ instanceId, clientId, method: 'qr' });

    const handles = bindSessionMetrics();
    const readBackoff = async () =>
      (await handles.reconnectAttemptsTotal.get()).values.find((v) => v.labels.reason === 'backoff')
        ?.value ?? 0;
    const before = await readBackoff();

    await sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });

    expect((await readBackoff()) - before).toBe(1);
  });

  it('close_515_reconnects_immediately_twice_then_third_escalates_to_backoff', async () => {
    const { clientId, instanceId, fence } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const nextDelayMs = vi.fn().mockReturnValue(999);

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      reconnect: {
        nextDelayMs,
        shouldGiveUp: vi.fn().mockReturnValue(false),
        onOpen: vi.fn().mockReturnValue(0),
      },
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });

    // 1st 515: stays within its own budget of 2 - immediate (delay 0).
    await sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    expect(nextDelayMs).not.toHaveBeenCalled();
    expect(scheduler.pendingCount()).toBe(1);
    await scheduler.fireAll();

    // 2nd 515: still within budget of 2 - immediate again.
    await sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    expect(nextDelayMs).not.toHaveBeenCalled();
    expect(scheduler.pendingCount()).toBe(1);
    await scheduler.fireAll();

    // 3rd 515: budget of 2 exhausted - escalates to the unknown-code path,
    // which DOES consume the jittered backoff delay.
    await sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    expect(nextDelayMs).toHaveBeenCalledTimes(1);
  });

  it('a_515_followed_by_a_428_schedules_a_full_jitter_delay_not_zero', async () => {
    const { clientId, instanceId, fence } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const nextDelayMs = vi.fn().mockReturnValue(777);

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      reconnect: {
        nextDelayMs,
        shouldGiveUp: vi.fn().mockReturnValue(false),
        onOpen: vi.fn().mockReturnValue(0),
      },
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });

    // 1st: a 515 - within its own budget of 2, reconnects immediately
    // (delay 0), leaving the counters at restart515Used=1, unknownAttempts=0.
    await sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    expect(nextDelayMs).not.toHaveBeenCalled();
    await scheduler.fireAll();

    // 2nd: a 428 arrives next. The counters snapshot still shows
    // restart515Used=1/unknownAttempts=0 (unchanged by a 428's own resolved
    // row, which carries budget=null) - the OLD counter-totals-based
    // inference would misread this as "still restart515" and reconnect at
    // delay 0. The FIX threads the just-resolved row's own budget through
    // explicitly: this 428 must schedule a real backoff delay (nextDelayMs's
    // return value), never 0.
    await sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    expect(nextDelayMs).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingCount()).toBe(1);
  });

  it('close_403_schedules_nothing_and_pauses_with_restriction_signal', async () => {
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

    await sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 403 } } },
    });

    expect(scheduler.pendingCount()).toBe(0);

    const row = await pool.query<{ health_state: string; user_action_reason: string | null }>(
      'SELECT health_state, user_action_reason FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(row.rows[0]?.health_state).toBe('paused');
    expect(row.rows[0]?.user_action_reason).toBe('RESTRICTION_SIGNAL');
  });

  it('eight_consecutive_428s_give_up_paused_reconnect_failed_and_release_lease', async () => {
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
      // Real MAX_ATTEMPTS=8 give-up semantics (@wp/domain) - a bare mock
      // returning `false` forever would never reach the give-up branch this
      // test proves.
      reconnect: {
        nextDelayMs: vi.fn().mockReturnValue(0),
        shouldGiveUp: vi.fn((attempt: number) => attempt >= 8),
        onOpen: vi.fn().mockReturnValue(0),
      },
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });

    for (let i = 0; i < 8; i += 1) {
      await sock.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 428 } } },
      });
      // Drain any timer the close scheduled so the NEXT close event fires
      // against a rebuilt socket, same as a real reconnect cycle.
      await scheduler.fireAll();
    }

    const row = await pool.query<{ health_state: string; user_action_reason: string | null }>(
      'SELECT health_state, user_action_reason FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect({
      healthState: row.rows[0]?.health_state,
      userActionReason: row.rows[0]?.user_action_reason,
    }).toEqual({ healthState: 'paused', userActionReason: 'RECONNECT_FAILED' });

    const leaseRow = await pool.query<{ released_at: Date | null }>(
      'SELECT released_at FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(leaseRow.rows[0]?.released_at).not.toBeNull();

    // P17 U6 (step 5) - exactly ONE `reconnect_budget_exhausted` notification
    // for this give-up transition.
    const notificationRows = await pool.query<{ kind: string; requires_user_action: boolean }>(
      `SELECT kind, requires_user_action FROM notifications WHERE instance_id = $1`,
      [instanceId],
    );
    expect(notificationRows.rows).toHaveLength(1);
    expect(notificationRows.rows[0]?.kind).toBe('reconnect_budget_exhausted');
    expect(notificationRows.rows[0]?.requires_user_action).toBe(true);
  });
});
