import { describe, expect, it, vi } from 'vitest';
import {
  onOpen,
  onConnectionUpdateSafe,
  type RunnerConnectionUpdateContext,
} from './runner-connection-update.js';
import type { CreateSessionRunnerDeps, FakeableSocket, RunnerSessionState } from './runner-types.js';

/**
 * runner-connection-update.test.ts (2026-09-22, "device paused" presence
 * fix, Task 2) - a pure unit-level proof of `onOpen`'s new
 * `sendPresenceUpdate('unavailable')` call, against hand-built fakes only
 * (no Postgres, no `buildRunner`/`runner-test-fixtures.ts` harness - unlike
 * `runner.test.ts`/`runner-reconnect.test.ts`, `onOpen` takes every
 * dependency as an explicit parameter, so it needs nothing real to exercise
 * directly). Mirrors `pairing.test.ts`'s own "fake repoCtx, no real
 * Postgres" style for the same reason: this module's own header comment
 * says the `RunnerConnectionUpdateContext` split exists exactly so its
 * pieces can be tested with explicit fakes.
 *
 * Covers the two behaviors the fix must have:
 *  - `sock.sendPresenceUpdate('unavailable')` is called on every open, after
 *    `markLinkedConnected`.
 *  - a REJECTING `sendPresenceUpdate` is swallowed (logged, never thrown)
 *    and never trips `onConnectionUpdateSafe`'s fail-safe teardown - proof
 *    the "best-effort only" requirement actually holds, not just that the
 *    call exists.
 */

function makeDeps(overrides: Partial<CreateSessionRunnerDeps> = {}): CreateSessionRunnerDeps {
  return {
    leaseManager: { acquire: vi.fn(), release: vi.fn() },
    heartbeat: { add: vi.fn(), remove: vi.fn() },
    buildAuthStore: vi.fn(),
    socketFactory: vi.fn(),
    instances: {
      applyEngineTransition: vi.fn(),
      runLoggedOutFlow: vi.fn(),
      markLinkedConnected: vi.fn().mockResolvedValue(undefined),
      readSessionEpoch: vi
        .fn()
        .mockResolvedValue({ sessionEpoch: 0, healthState: 'never_linked', linkState: 'unlinked' }),
    },
    pairing: {
      onQr: vi.fn(),
      onOpen: vi.fn(),
      startCodePairing: vi.fn(),
    },
    connectGate: { take: vi.fn().mockResolvedValue(undefined) },
    publish: vi.fn(),
    resolveDisconnect: vi.fn(),
    toFsmRow: vi.fn(),
    reconnect: {
      nextDelayMs: vi.fn().mockReturnValue(0),
      shouldGiveUp: vi.fn().mockReturnValue(false),
      onOpen: vi.fn().mockReturnValue(0),
    },
    rng: { random: () => 0.5 },
    clock: { now: () => 1_000 },
    setTimeoutFn: vi.fn(),
    clearTimeoutFn: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    workerId: 'worker-test',
    env: 'test',
    expectedTakeoverCheck: vi.fn().mockResolvedValue(false),
    // `onOpen` never touches `registry`/`sessionOwner` (only
    // `deps.instances`/`deps.pairing`/`deps.publish`/`deps.clock`/
    // `deps.reconnect`/`state.authStore` - verified by reading the function
    // body) - a real empty Map and an untyped stub are enough to satisfy
    // `CreateSessionRunnerDeps`'s shape without asserting anything about
    // their behavior.
    registry: new Map(),
    sessionOwner: {} as CreateSessionRunnerDeps['sessionOwner'],
    ...overrides,
  };
}

function makeState(overrides: Partial<RunnerSessionState> = {}): RunnerSessionState {
  return {
    instanceId: 'inst-1',
    clientId: 'client-1',
    lease: {
      instanceId: 'inst-1',
      clientId: 'client-1',
      fence: 1n,
      workerId: 'worker-test',
      graceMs: 0,
    },
    authStore: {
      saveCreds: vi.fn().mockResolvedValue({ credVersion: 1n }),
    } as unknown as RunnerSessionState['authStore'],
    healthState: 'never_linked',
    linkState: 'unlinked',
    attempt: 0,
    openedAtMs: null,
    pendingReconnectTimer: undefined,
    pendingOffsetTimer: undefined,
    sessionEpoch: 0,
    credVersion: 0n,
    ended: false,
    sockGeneration: 0,
    closeInFlightGeneration: undefined,
    releasedLease: false,
    tornDown: false,
    ...overrides,
  };
}

function makeSock(overrides: Partial<FakeableSocket> = {}): FakeableSocket {
  return {
    ev: { on: vi.fn() },
    end: vi.fn(),
    user: { id: '111@s.whatsapp.net' },
    ...overrides,
  };
}

function makeCtx(
  deps: CreateSessionRunnerDeps,
  state: RunnerSessionState,
): RunnerConnectionUpdateContext {
  return {
    deps,
    state,
    counters: { restart515Used: 0, unknownAttempts: 0 },
    endSocketOnce: vi.fn(),
    buildAndWireSocket: vi.fn().mockResolvedValue(undefined),
    teardownWithRelease: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    connectGateAbortController: vi.fn().mockReturnValue(new AbortController()),
  };
}

describe('onOpen sendPresenceUpdate(unavailable)', () => {
  it('calls_send_presence_update_unavailable_after_marking_linked_connected', async () => {
    const deps = makeDeps();
    const state = makeState();
    const callOrder: string[] = [];
    (deps.instances.markLinkedConnected as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('markLinkedConnected');
    });
    const sendPresenceUpdate = vi.fn().mockImplementation(async () => {
      callOrder.push('sendPresenceUpdate');
    });
    const sock = makeSock({ sendPresenceUpdate });
    const ctx = makeCtx(deps, state);

    await onOpen(ctx, sock, { creds: 'fake' });

    expect(sendPresenceUpdate).toHaveBeenCalledExactlyOnceWith('unavailable');
    expect(callOrder).toEqual(['markLinkedConnected', 'sendPresenceUpdate']);
  });

  it('omitted_send_presence_update_never_throws_optional_chaining_covers_older_fakes', async () => {
    const deps = makeDeps();
    const state = makeState();
    const sock = makeSock(); // no sendPresenceUpdate field at all
    const ctx = makeCtx(deps, state);

    await expect(onOpen(ctx, sock, { creds: 'fake' })).resolves.toBeUndefined();
  });

  it('a_rejecting_send_presence_update_is_swallowed_logged_and_never_thrown', async () => {
    const deps = makeDeps();
    const state = makeState();
    const sendPresenceUpdate = vi.fn().mockRejectedValue(new Error('boom: socket not ready'));
    const sock = makeSock({ sendPresenceUpdate });
    const ctx = makeCtx(deps, state);

    await expect(onOpen(ctx, sock, { creds: 'fake' })).resolves.toBeUndefined();

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('sendPresenceUpdate'),
      expect.objectContaining({ instanceId: 'inst-1', clientId: 'client-1' }),
    );
    // The rest of onOpen's own work still completed - a presence hiccup
    // must never abort the open.
    expect(state.healthState).toBe('connected');
    expect(state.linkState).toBe('linked');
    expect(deps.pairing.onOpen).toHaveBeenCalledTimes(1);
    expect(deps.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'instance.health_changed' }),
    );
  });

  it('a_rejecting_send_presence_update_never_trips_onConnectionUpdateSafes_fail_safe_teardown', async () => {
    const deps = makeDeps();
    const state = makeState();
    const sendPresenceUpdate = vi.fn().mockRejectedValue(new Error('boom'));
    const sock = makeSock({ sendPresenceUpdate });
    const ctx = makeCtx(deps, state);

    // onConnectionUpdateSafe is the REAL fail-safe boundary in production -
    // any OTHER unexpected error thrown out of onConnectionUpdate here would
    // be caught by it and routed to `ctx.teardown({ release: false })`. This
    // proves the presence rejection never escapes onOpen far enough to reach
    // that boundary at all.
    await onConnectionUpdateSafe(ctx, { connection: 'open' }, sock, { creds: 'fake' }, 0);

    expect(ctx.teardown).not.toHaveBeenCalled();
    expect(state.healthState).toBe('connected');
  });
});
