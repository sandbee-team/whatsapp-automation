import { initAuthCreds } from 'baileys';
import type { DisconnectBudgetCounters } from '@wp/domain';
import type { RunnerHandle } from './registry.js';
import { runDeferredSocketOpen } from './runner-deferred-open.js';
import {
  onConnectionUpdateSafe,
  type RunnerConnectionUpdateContext,
} from './runner-connection-update.js';
import {
  buildOnCredsSaveBufferError,
  runTeardownFlush,
  seedCredVersionOnceIfNeeded,
  wireCredsUpdateListener,
} from './runner-creds-update.js';
import {
  buildGetSendSocket,
  buildGetGroupSocket,
  buildInventorySnapshot,
} from './runner-handle.js';
import type {
  CreateSessionRunnerDeps,
  FakeableSocket,
  RunnerSessionState,
  StartInput,
  StartResult,
} from './runner-types.js';

export type { CreateSessionRunnerDeps, FakeableSocket, StartInput, StartResult };

/**
 * runner.ts (P08 U5a) - `createSessionRunner`: the per-instance session
 * lifecycle - lease -> auth state -> socket -> `connection.update` handling.
 * ALL I/O is injected (see runner-types.ts), so this is testable against a
 * fake socket with real Postgres writes flowing through the U4 repo/service.
 * `start()` runs the FIXED order: connectGate -> leaseManager.acquire ->
 * heartbeat.add + registry.set -> readSessionEpoch -> buildAuthStore ->
 * loadCreds ?? initAuthCreds -> socketFactory -> wire connection.update. A
 * reconnect rebuilds the socket on the SAME lease/store via the SAME
 * internal `buildAndWireSocket` - never re-acquiring the lease or rebuilding the auth store.
 */
export function createSessionRunner(deps: CreateSessionRunnerDeps) {
  const registry = deps.registry;

  async function start(input: StartInput): Promise<StartResult> {
    const lease = await deps.leaseManager.acquire({
      instanceId: input.instanceId,
      clientId: input.clientId,
    });
    if (!lease) {
      return 'not_acquired';
    }

    deps.heartbeat.add(lease);

    // Monotonic acquire timestamp for the fleet SessionInventory adapter's
    // `acquiredAtMonotonic` (shed.ts's own victim-selection input) - always
    // `performance.now()`, deliberately independent of the injected wall
    // clock (`deps.clock`), which tests may pin to an arbitrary fixed value.
    const acquiredAtMonotonic = performance.now();

    const epochInfo = await deps.instances.readSessionEpoch(input.instanceId, input.clientId);
    const counters: DisconnectBudgetCounters = { restart515Used: 0, unknownAttempts: 0 };

    const state: RunnerSessionState = {
      instanceId: input.instanceId,
      clientId: input.clientId,
      lease,
      authStore: undefined as never, // assigned synchronously below, before any use
      healthState: epochInfo.healthState as RunnerSessionState['healthState'],
      linkState: epochInfo.linkState as RunnerSessionState['linkState'],
      attempt: 0,
      openedAtMs: null,
      pendingReconnectTimer: undefined,
      pendingOffsetTimer: undefined,
      sessionEpoch: epochInfo.sessionEpoch,
      // FIX-A (P26 C1 review): placeholder, seeded for real in buildAndWireSocket (never used for a save before then).
      credVersion: 0n,
      ended: false,
      sockGeneration: 0,
      closeInFlightGeneration: undefined,
      releasedLease: false,
      tornDown: false,
    };

    let currentSock: FakeableSocket | undefined;

    // One AbortController per session, aborted by BOTH teardown variants
    // alongside clearPendingOffset() - a parked connectGate.take() is
    // promptly rejected rather than outliving this session's lease release.
    // Fresh per socket-open attempt - a LATER reconnect's take() is never
    // pre-aborted by an EARLIER one's.
    let connectGateAbort: AbortController | undefined;
    function connectGateAbortController(): AbortController {
      const controller = new AbortController();
      connectGateAbort = controller;
      return controller;
    }

    /**
     * Idempotent: ends the current socket at most once per build. Both the
     * pairing-exhaustion path (which per spec calls `handle.sock.end`
     * directly, BEFORE `teardownWithRelease`) and every teardown path route
     * through this single guard, so a socket already ended by pairing is
     * never ended a second time by teardown.
     */
    function endSocketOnce(err?: Error): void {
      if (state.ended) {
        return;
      }
      state.ended = true;
      currentSock?.end(err);
    }

    const handle: RunnerHandle = {
      instanceId: input.instanceId,
      clientId: input.clientId,
      end: (err?: Error) => endSocketOnce(err),
      teardownNoRelease: () => teardown({ release: false }),
      teardownWithRelease: () => teardown({ release: true }),
      // P12 U0 / P24 U3 (accessors split into runner-handle.ts for max-lines).
      getSendSocket: buildGetSendSocket(() => currentSock, state),
      getGroupSocket: buildGetGroupSocket(() => currentSock, state),
      inventorySnapshot: buildInventorySnapshot(acquiredAtMonotonic, state),
    };
    registry.set(input.instanceId, handle);

    // FIX-A (P26 C1 review) - see buildOnCredsSaveBufferError's doc for why a setter is called after buildAuthStore returns.
    const { onCredsSaveBufferError, setCredsSaveBuffer } = buildOnCredsSaveBufferError(
      deps,
      state,
      teardown,
    );

    const { store, credsSaveBuffer } = deps.buildAuthStore(
      {
        instanceId: input.instanceId,
        clientId: input.clientId,
        sessionEpoch: epochInfo.sessionEpoch,
        fence: lease.fence,
        env: deps.env,
        workerId: deps.workerId,
      },
      {
        onFenceConflict: () => handle.teardownNoRelease(),
        onSignalWriteFailure: () => applyDegradeKeepSocket(),
        releaseLease: () => deps.leaseManager.release(state.lease),
        onCredsSaveBufferError,
        // FIX-P26-G - see AuthStorePortsLike's doc.
        readCredVersion: () => state.credVersion,
        onCredsSaveBufferFlushed: (credVersion) => {
          state.credVersion = credVersion;
        },
      },
    );
    state.authStore = store;
    setCredsSaveBuffer(credsSaveBuffer);

    async function applyDegradeKeepSocket(): Promise<void> {
      // Fence-guarded degrade transition, keeping the socket open - a
      // Signal-tier write failure is not itself a fence loss.
      await deps.instances.applyEngineTransition(
        { healthState: 'degraded', sideEffects: [] },
        state.healthState,
        { fence: state.lease.fence, workerId: deps.workerId },
      );
      state.healthState = 'degraded';
    }

    const credVersionSeeded = { done: false }; // FIX-A: see seedCredVersionOnceIfNeeded's doc.

    async function buildAndWireSocket(): Promise<void> {
      const credVersionPromise = seedCredVersionOnceIfNeeded(state.authStore, credVersionSeeded);
      if (credVersionPromise) {
        state.credVersion = await credVersionPromise;
      }
      const creds = (await state.authStore.loadCreds()) ?? initAuthCreds();
      const sock = deps.socketFactory({ creds, keys: {} });
      currentSock = sock;
      state.ended = false;
      state.sockGeneration += 1;
      state.closeInFlightGeneration = undefined;
      const generation = state.sockGeneration;
      sock.ev.on('connection.update', (raw: unknown) =>
        onConnectionUpdateSafe(connectionUpdateContext(), raw, sock, creds, generation),
      );
      // P26 U6a - the real Baileys `creds.update` event, behind the SAME fail-safe boundary a `connection.update` handler gets (FIX-A: see runner-creds-update.ts's header).
      if (credsSaveBuffer) {
        wireCredsUpdateListener({ deps, state, credsSaveBuffer, teardown }, sock, creds);
      }
      if (deps.onMessagesUpsert) {
        sock.ev.on('messages.upsert', deps.onMessagesUpsert);
      }
      if (deps.onMessagesUpdate) {
        sock.ev.on('messages.update', deps.onMessagesUpdate);
      }
      if (deps.onMessageReceiptUpdate) {
        sock.ev.on('message-receipt.update', deps.onMessageReceiptUpdate);
      }
    }

    // connection.update handling (onConnectionUpdateSafe trio) lives in
    // runner-connection-update.ts (split at FIX-P09-B for max-lines);
    // `connectionUpdateContext()` bundles fresh state/callbacks per call.
    function connectionUpdateContext(): RunnerConnectionUpdateContext {
      return {
        deps,
        state,
        counters,
        endSocketOnce,
        buildAndWireSocket,
        teardownWithRelease: handle.teardownWithRelease,
        teardown,
        connectGateAbortController,
      };
    }

    function clearPendingReconnect(): void {
      if (state.pendingReconnectTimer !== undefined) {
        deps.clearTimeoutFn(state.pendingReconnectTimer);
        state.pendingReconnectTimer = undefined;
      }
    }

    let resolvePendingOffset: (() => void) | undefined;
    function setResolvePendingOffset(resolve: (() => void) | undefined): void {
      resolvePendingOffset = resolve;
    }

    /**
     * Cancels whichever deferred wait (`waitDeferred`, in
     * runner-deferred-open.ts, shared by the lease's takeover-grace leg and
     * the connect-offset leg) is currently pending, AND unblocks its own
     * `await` immediately (never lets a concurrent teardown/drain leave
     * `start()` hanging on a timer that will now never fire) - the resumed
     * caller re-checks `state.tornDown`/`state.ended` before ever calling
     * `buildAndWireSocket()`, so cancellation here still guarantees no socket
     * opens after teardown, it just resolves the wait promptly instead of
     * leaving it unsettled.
     */
    function clearPendingOffset(): void {
      if (state.pendingOffsetTimer !== undefined) {
        deps.clearTimeoutFn(state.pendingOffsetTimer);
        state.pendingOffsetTimer = undefined;
      }
      if (resolvePendingOffset !== undefined) {
        const resolve = resolvePendingOffset;
        resolvePendingOffset = undefined;
        resolve();
      }
    }

    // P09 U6b / fleet-recovery FIX - offset/takeover-grace/connect-gate waits
    // run as ONE fire-and-forget chain (`runDeferredSocketOpen`, below)
    // rather than blocking `start()`'s return - rationale in that file's doc.
    async function teardown(options: { release: boolean }): Promise<void> {
      state.tornDown = true;
      clearPendingReconnect();
      clearPendingOffset();
      connectGateAbort?.abort();
      endSocketOnce(undefined);
      deps.heartbeat.remove(input.instanceId);
      registry.delete(input.instanceId);
      if (credsSaveBuffer) {
        // FIX-A (MAJOR 6) - bounded, best-effort (see runTeardownFlush's doc); the retry timer is disposed right after so nothing lingers.
        await runTeardownFlush(credsSaveBuffer, deps.setTimeoutFn);
        credsSaveBuffer.dispose();
      }
      if (options.release) {
        // Guard set BEFORE the await (FIX BATCH A, A4): two teardown callers
        // racing on the SAME handle must release at most once - the second
        // caller sees releasedLease already true and returns early instead
        // of double-releasing (which could clobber a new owner's lease row).
        if (state.releasedLease) {
          return;
        }
        state.releasedLease = true;
        await deps.leaseManager.release(state.lease);
      }
    }

    // FIRE-AND-FORGET (P09 U6b, extended by the P09 fleet-recovery FIX):
    // `start()` must NOT await the connect-gate/takeover-grace/wave-connect
    // offset waits - see runner-deferred-open.ts's own doc for the full
    // rationale (preserved there verbatim) - still cancellable via clearPendingOffset().
    void runDeferredSocketOpen(
      {
        deps,
        state,
        instanceId: input.instanceId,
        waveConnect: input.waveConnect,
        connectGateAbortController,
        buildAndWireSocket,
      },
      setResolvePendingOffset,
    );
    return handle;
  }

  return { start };
}
