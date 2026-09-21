import type { DisconnectBudgetCounters } from '@wp/domain';
import { handleClose, type LastDisconnectLike } from './runner-disconnect.js';
import type {
  CreateSessionRunnerDeps,
  FakeableSocket,
  RunnerSessionState,
} from './runner-types.js';

/**
 * runner-connection-update.ts (FIX-P09-B split) - the `connection.update`
 * handling trio (`onConnectionUpdateSafe`/`onConnectionUpdate`/`onOpen`),
 * mechanically extracted out of `runner.ts`'s `start()` for the max-lines
 * cap. Pure code motion: explicit parameters replace closed-over module
 * state (a `RunnerConnectionUpdateContext` bundles the callbacks/state the
 * trio needs from its `start()` closure). No logic change.
 */

export function parsePhoneFromJid(jid: string): string {
  const beforeColon = jid.split(':')[0] ?? jid;
  const beforeAt = beforeColon.split('@')[0] ?? beforeColon;
  return beforeAt;
}

export interface RunnerConnectionUpdateContext {
  deps: CreateSessionRunnerDeps;
  state: RunnerSessionState;
  counters: DisconnectBudgetCounters;
  endSocketOnce: (err?: Error) => void;
  buildAndWireSocket: () => Promise<void>;
  teardownWithRelease: () => Promise<void>;
  teardown: (options: { release: boolean }) => Promise<void>;
  connectGateAbortController: () => AbortController;
}

/**
 * Fail-safe boundary (P08 E3 FIX 2) around every `connection.update`
 * callback: a `StateWriteLostFenceError` (or the runner already having
 * ended this generation) is caught and logged as a safe no-op - never
 * resurrects state, never rethrows into the socket's own event emitter.
 * Any OTHER unexpected error is routed to a fail-safe teardown WITHOUT
 * release (the lease's fate is unknown, so releasing it could hand the
 * slot to a new owner while this process still half-believes it owns
 * it) plus a warn - never an unhandled rejection from a Baileys callback.
 */
export async function onConnectionUpdateSafe(
  ctx: RunnerConnectionUpdateContext,
  raw: unknown,
  sock: FakeableSocket,
  creds: unknown,
  generation: number,
): Promise<void> {
  try {
    await onConnectionUpdate(ctx, raw, sock, creds, generation);
  } catch (err) {
    const { deps, state } = ctx;
    if (err instanceof Error && err.name === 'StateWriteLostFenceError') {
      deps.logger.warn('connection.update ignored: lost fence', {
        instanceId: state.instanceId,
        clientId: state.clientId,
      });
      return;
    }
    deps.logger.warn('connection.update handler failed: tearing down without release', {
      instanceId: state.instanceId,
      clientId: state.clientId,
    });
    await ctx.teardown({ release: false });
  }
}

export async function onConnectionUpdate(
  ctx: RunnerConnectionUpdateContext,
  raw: unknown,
  sock: FakeableSocket,
  creds: unknown,
  generation: number,
): Promise<void> {
  const { deps, state, counters, endSocketOnce, buildAndWireSocket, teardownWithRelease } = ctx;
  const update = raw as {
    qr?: string;
    connection?: 'open' | 'close' | 'connecting';
    lastDisconnect?: LastDisconnectLike;
  };

  if (update.qr !== undefined) {
    // FIX (P08 FIX BATCH A, A6): same guard the 'open' branch already
    // has - a late qr event for a torn-down/stale generation (e.g. after
    // a Redis-only onFenceLost -> teardownNoRelease, where the Postgres
    // fence row itself never moved so the write below would otherwise
    // SUCCEED) must be ignored before any write or publish.
    if (state.ended || generation !== state.sockGeneration) {
      return;
    }
    await deps.pairing.onQr(
      {
        sock: { end: (err?: Error) => endSocketOnce(err) },
        teardownWithRelease,
      },
      update.qr,
    );
    return;
  }

  if (update.connection === 'open') {
    // FIX 2: a stray 'open' for a stale/torn-down generation (or after
    // this runner has already ended) is ignored before any write.
    if (state.ended || generation !== state.sockGeneration) {
      return;
    }
    await onOpen(ctx, sock, creds);
    return;
  }

  if (update.connection === 'close') {
    // FIX 1: single-flight guard - Baileys can re-emit 'close' for the
    // SAME underlying disconnect. Once a close is being (or has been)
    // handled for this generation, ignore subsequent closes for it.
    if (state.closeInFlightGeneration === generation) {
      return;
    }
    state.closeInFlightGeneration = generation;
    await handleClose({
      deps,
      state,
      counters,
      lastDisconnect: update.lastDisconnect,
      reconnectSameLease: buildAndWireSocket,
      teardownWithRelease,
      connectGateAbortController: ctx.connectGateAbortController,
    });
  }
}

export async function onOpen(
  ctx: RunnerConnectionUpdateContext,
  sock: FakeableSocket,
  creds: unknown,
): Promise<void> {
  const { deps, state } = ctx;
  // FIX-A (P26 C1 review, CRITICAL 1 finding): this pre-dates P26 and was the
  // SAME latent misuse the review flagged in the new `creds.update` path -
  // `expectedVersion` is the auth store's own `cred_version`, never
  // `sessionEpoch` (a different quantity entirely). `state.credVersion` is
  // seeded from `authStore.currentCredVersion()` in `buildAndWireSocket` and
  // kept current from every successful save's resolved version.
  const { credVersion } = await state.authStore.saveCreds({
    creds,
    expectedVersion: state.credVersion,
    fence: state.lease.fence,
  });
  state.credVersion = credVersion;

  const jid = sock.user?.id ?? null;
  const phoneE164 = jid ? parsePhoneFromJid(jid) : null;

  await deps.instances.markLinkedConnected({ ownerJid: jid, phoneE164 });
  state.healthState = 'connected';
  state.linkState = 'linked';

  // "Device paused" presence fix (2026-09-22, Task 2) - documented bug in
  // our EXACT pinned `baileys@7.0.0-rc14` (app/backend/package.json): during
  // a partial creds update Baileys itself broadcasts a spurious "available"
  // presence, defeating `markOnlineOnConnect: false`
  // (provider/baileys/socket-factory.ts:172) FROM INSIDE THE LIBRARY - our
  // own config option has no effect on that internal broadcast. The
  // operator then sees the linked device as paused/stalled on the phone.
  // The standard mitigation mature Baileys deployments use is exactly this:
  // explicitly call `sendPresenceUpdate('unavailable')` right after the
  // connection opens, overriding whatever presence Baileys just broadcast
  // on its own. BEST-EFFORT ONLY - never let this throw into the
  // connection-open path: `onConnectionUpdateSafe` (this file) tears the
  // whole socket down on any unexpected error from this function, and a
  // presence hiccup must never cost the session its connection. Optional
  // chaining covers a fake socket in tests that predates this field.
  // REVISIT: when Baileys is upgraded past rc14, re-check whether this
  // upstream bug is fixed before assuming this call is still needed.
  try {
    await sock.sendPresenceUpdate?.('unavailable');
  } catch (err) {
    deps.logger.warn('sendPresenceUpdate(unavailable) failed after connection open: ignoring', {
      instanceId: state.instanceId,
      clientId: state.clientId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  deps.pairing.onOpen({ sock, teardownWithRelease: ctx.teardownWithRelease });
  deps.publish({
    type: 'instance.health_changed',
    clientId: state.clientId,
    instanceId: state.instanceId,
  });

  const previousOpenedAtMs = state.openedAtMs;
  const now = deps.clock.now();
  if (previousOpenedAtMs !== null) {
    state.attempt = deps.reconnect.onOpen({
      openedAtMs: previousOpenedAtMs,
      closedAtMs: now,
      attempt: state.attempt,
    });
  }
  state.openedAtMs = now;
}
