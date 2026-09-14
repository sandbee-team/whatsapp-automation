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
 * runner.c2.retry-storm.test.ts (P08 C2, targeted category 6: retry storm
 * bounds) - split out of runner.c2.test.ts purely to keep that suite under
 * max-lines.
 */

afterAll(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('runner.c2 - retry storm bounds (30 rapid closes across 3 generations)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('thirty_rapid_428_closes_produce_bounded_pending_timers_and_monotonic_attempts', async () => {
    const { clientId, instanceId, fence } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    // shouldGiveUp never trips in this test - it isolates timer/attempt
    // bookkeeping from the give-up path (already covered by
    // eight_consecutive_428s_give_up_paused_reconnect_failed_and_release_lease
    // in runner-reconnect.test.ts).
    const nextDelayMs = vi.fn().mockReturnValue(50);

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

    let maxPending = 0;
    for (let i = 0; i < 30; i += 1) {
      await sock.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 428 } } },
      });
      maxPending = Math.max(maxPending, scheduler.pendingCount());
      // Never more than ONE pending timer at a time - each close schedules
      // exactly one reconnect, and the reconnect fires (rebuilding the
      // socket, bumping the generation) before the next close is emitted.
      expect(scheduler.pendingCount()).toBeLessThanOrEqual(1);
      await scheduler.fireAll();
      expect(scheduler.pendingCount()).toBe(0);
    }

    expect(maxPending).toBeLessThanOrEqual(1);

    // Exactly one audit row per real transition into 'connected' -> something
    // else - the FIRST close (connected -> degraded/whatever 428 maps to)
    // writes one; every SUBSequent 428-close from an already-non-connected
    // health state does not re-trigger the "leaving connected" audit branch
    // (service.ts's writeTransitionAuditIfLeavingConnected: `if (fromHealth
    // !== 'connected') return;`).
    const auditRows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE target_id = $1`,
      [instanceId],
    );
    expect(auditRows.rows.length).toBe(1);

    // Attempt counter monotonic (never resets mid-storm - no 'open' event
    // fires in this test, so onOpen's reset path never runs).
    expect(nextDelayMs.mock.calls.length).toBeGreaterThan(0);
    const attemptsSeen = nextDelayMs.mock.calls.map((call) => call[0].attempt as number);
    for (let i = 1; i < attemptsSeen.length; i += 1) {
      expect(attemptsSeen[i]).toBeGreaterThan(attemptsSeen[i - 1]!);
    }
  });
});
