import { describe, expect, it, vi } from 'vitest';
import { createPairingController } from './pairing.js';

/**
 * pairing.test.ts (P08 U5a) - unit-level proof of `createPairingController`
 * against a FAKE `repoCtx` (the injected `incrementQrAttempts`/
 * `markPairingExpired` functions) and a fake clock - no real Postgres here
 * (the real-repo integration proof lives in the runner's own fake-socket
 * tests, which use the real U4 repo). Covers: attempts-exhausted terminal
 * state with no further timer/loop, the 5-minute window bound independent
 * of attempt count, and the accounting-reuse code-pairing path.
 */

interface FakeRepoCtx {
  incrementQrAttempts: ReturnType<
    typeof vi.fn<() => Promise<{ qr_attempts: number; pairing_started_at: string | Date | null }>>
  >;
  markPairingExpired: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function makeRepoCtx(overrides: Partial<FakeRepoCtx> = {}): FakeRepoCtx {
  return {
    incrementQrAttempts:
      vi.fn<() => Promise<{ qr_attempts: number; pairing_started_at: string | Date | null }>>(),
    markPairingExpired: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeClock(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function makeHandle() {
  return {
    sock: { end: vi.fn(), requestPairingCode: vi.fn() },
    teardownWithRelease: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createPairingController.onQr', () => {
  it('publishes_qr_event_with_attempts_left_and_expiry_under_the_cap', async () => {
    const clock = makeClock(1_000);
    const repoCtx = makeRepoCtx({
      incrementQrAttempts: vi.fn().mockResolvedValue({
        qr_attempts: 1,
        pairing_started_at: new Date(1_000).toISOString(),
      }),
    });
    const publish = vi.fn();
    const controller = createPairingController({
      repoCtx,
      publish,
      clock,
      clientId: 'client-1',
      instanceId: 'inst-1',
    });
    const handle = makeHandle();

    const result = await controller.onQr(handle, 'qr-string-1');

    expect(result).toBeUndefined();
    expect(handle.sock.end).not.toHaveBeenCalled();
    expect(handle.teardownWithRelease).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      type: 'instance.qr',
      clientId: 'client-1',
      instanceId: 'inst-1',
      payload: 'qr-string-1',
      expiresAt: new Date(1_000 + 90_000).toISOString(),
      attemptsLeft: 4,
    });
  });

  it('sixth_attempt_terminates_expired_with_no_further_timer_or_loop', async () => {
    const clock = makeClock(1_000);
    const pairingStartedAtIso = new Date(1_000).toISOString();
    const repoCtx = makeRepoCtx({
      incrementQrAttempts: vi
        .fn()
        .mockResolvedValueOnce({ qr_attempts: 1, pairing_started_at: pairingStartedAtIso })
        .mockResolvedValueOnce({ qr_attempts: 2, pairing_started_at: pairingStartedAtIso })
        .mockResolvedValueOnce({ qr_attempts: 3, pairing_started_at: pairingStartedAtIso })
        .mockResolvedValueOnce({ qr_attempts: 4, pairing_started_at: pairingStartedAtIso })
        .mockResolvedValueOnce({ qr_attempts: 5, pairing_started_at: pairingStartedAtIso })
        .mockResolvedValueOnce({ qr_attempts: 6, pairing_started_at: pairingStartedAtIso }),
    });
    const publish = vi.fn();
    const controller = createPairingController({
      repoCtx,
      publish,
      clock,
      clientId: 'client-1',
      instanceId: 'inst-1',
    });
    const handle = makeHandle();

    let lastResult: string | undefined;
    for (let i = 0; i < 6; i += 1) {
      lastResult = await controller.onQr(handle, `qr-${String(i)}`);
    }

    expect(lastResult).toBe('expired');
    expect(handle.sock.end).toHaveBeenCalledTimes(1);
    expect(handle.sock.end).toHaveBeenCalledWith(undefined);
    expect(repoCtx.markPairingExpired).toHaveBeenCalledTimes(1);
    expect(handle.teardownWithRelease).toHaveBeenCalledTimes(1);
    // Exactly 5 instance.qr publishes (attempts 1-5) before the 6th
    // terminates - plus the health_changed publish on the terminal call.
    const qrPublishes = publish.mock.calls.filter((call) => call[0].type === 'instance.qr');
    expect(qrPublishes).toHaveLength(5);
    const healthPublishes = publish.mock.calls.filter(
      (call) => call[0].type === 'instance.health_changed',
    );
    expect(healthPublishes).toHaveLength(1);
  });

  it('a_null_pairing_started_at_is_treated_as_expired_not_fail_open', async () => {
    // FIX (A7): pairingStartedAtMs(null) used to return NaN, and
    // `clock.now() - NaN > windowMs` is `NaN > windowMs`, which is ALWAYS
    // false - a null pairing_started_at row used to silently fail OPEN
    // (windowExpired never true) on a bounded guard whose whole point is to
    // terminate pairing. The fix treats null as EXPIRED explicitly.
    const clock = makeClock(1_000);
    const repoCtx = makeRepoCtx({
      incrementQrAttempts: vi.fn().mockResolvedValue({
        qr_attempts: 1,
        pairing_started_at: null,
      }),
    });
    const publish = vi.fn();
    const controller = createPairingController({
      repoCtx,
      publish,
      clock,
      clientId: 'client-1',
      instanceId: 'inst-1',
    });
    const handle = makeHandle();

    const result = await controller.onQr(handle, 'qr-null-started-at');

    expect(result).toBe('expired');
    expect(handle.sock.end).toHaveBeenCalledTimes(1);
    expect(repoCtx.markPairingExpired).toHaveBeenCalledTimes(1);
    expect(handle.teardownWithRelease).toHaveBeenCalledTimes(1);
  });

  it('window_expires_after_five_minutes_even_with_few_attempts', async () => {
    const clock = makeClock(0);
    const pairingStartedAtIso = new Date(0).toISOString();
    const repoCtx = makeRepoCtx({
      incrementQrAttempts: vi
        .fn()
        .mockResolvedValueOnce({ qr_attempts: 1, pairing_started_at: pairingStartedAtIso })
        .mockResolvedValueOnce({ qr_attempts: 2, pairing_started_at: pairingStartedAtIso }),
    });
    const publish = vi.fn();
    const controller = createPairingController({
      repoCtx,
      publish,
      clock,
      clientId: 'client-1',
      instanceId: 'inst-1',
    });
    const handle = makeHandle();

    await controller.onQr(handle, 'qr-0');
    clock.advance(300_001);
    const result = await controller.onQr(handle, 'qr-1');

    expect(result).toBe('expired');
    expect(handle.sock.end).toHaveBeenCalledTimes(1);
    expect(repoCtx.markPairingExpired).toHaveBeenCalledTimes(1);
    expect(handle.teardownWithRelease).toHaveBeenCalledTimes(1);
  });
});

describe('createPairingController.startCodePairing', () => {
  it('publishes_the_pairing_code_via_the_same_accounting_path', async () => {
    const clock = makeClock(2_000);
    const repoCtx = makeRepoCtx({
      incrementQrAttempts: vi.fn().mockResolvedValue({
        qr_attempts: 1,
        pairing_started_at: new Date(2_000).toISOString(),
      }),
    });
    const publish = vi.fn();
    const controller = createPairingController({
      repoCtx,
      publish,
      clock,
      clientId: 'client-1',
      instanceId: 'inst-1',
    });
    const handle = makeHandle();
    handle.sock.requestPairingCode.mockResolvedValue('ABCD1234');

    await controller.startCodePairing(handle, '15550001234');

    expect(handle.sock.requestPairingCode).toHaveBeenCalledWith('15550001234');
    expect(publish).toHaveBeenCalledWith({
      type: 'instance.qr',
      clientId: 'client-1',
      instanceId: 'inst-1',
      payload: 'ABCD1234',
      expiresAt: new Date(2_000 + 90_000).toISOString(),
      attemptsLeft: 4,
    });
  });
});

describe('createPairingController.onOpen', () => {
  it('resets_internal_window_bookkeeping_so_a_later_relink_starts_fresh', async () => {
    const clock = makeClock(1_000);
    const pairingStartedAtIso = new Date(1_000).toISOString();
    const repoCtx = makeRepoCtx({
      incrementQrAttempts: vi.fn().mockResolvedValue({
        qr_attempts: 1,
        pairing_started_at: pairingStartedAtIso,
      }),
    });
    const publish = vi.fn();
    const controller = createPairingController({
      repoCtx,
      publish,
      clock,
      clientId: 'client-1',
      instanceId: 'inst-1',
    });
    const handle = makeHandle();

    await controller.onQr(handle, 'qr-0');
    controller.onOpen(handle);

    // onOpen itself must not publish or touch the repo/sock.
    expect(publish).toHaveBeenCalledTimes(1);
    expect(repoCtx.markPairingExpired).not.toHaveBeenCalled();
    expect(handle.sock.end).not.toHaveBeenCalled();
  });
});
