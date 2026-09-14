import { instanceConnectOffsetMs } from '../fleet/connect-budget.js';
import type { CreateSessionRunnerDeps, RunnerSessionState } from './runner-types.js';

/**
 * runner-deferred-open.ts (FIX-P09-B split) - the fire-and-forget deferred-
 * open chain (connect-gate token wait -> lease takeover-grace wait ->
 * U6b connect-offset wait -> `buildAndWireSocket()`), mechanically
 * extracted out of `runner.ts`'s `start()` for the max-lines cap. Pure code
 * motion: explicit parameters replace closed-over module state; every
 * pinning test (`runner-connect-offset.test.ts`,
 * `runner-lease-grace-offset.test.ts`, `runner-connect-gate-abort.test.ts`)
 * stays green unchanged. No logic change.
 *
 * See runner.ts's own (preserved, unmoved) doc comment above its call site
 * for the full ordering-deviation rationale (connect-gate wait moved out of
 * `start()`'s synchronous path by the P09 fleet-recovery FIX) and the "why
 * not from discovery" / "why start() does not await this wait" analysis -
 * none of that reasoning changed, only which file the code implementing it
 * lives in.
 */

export interface WaitForDeferredSocketOpenInput {
  deps: Pick<CreateSessionRunnerDeps, 'connectGate' | 'setTimeoutFn' | 'clearTimeoutFn' | 'logger'>;
  state: RunnerSessionState;
  instanceId: string;
  waveConnect: boolean | undefined;
  connectGateAbortController: () => AbortController;
  buildAndWireSocket: () => Promise<void>;
}

/** Non-zero exactly when both gating conditions hold AND the deterministic offset itself is non-zero for this instance - the single source of truth for the fire-and-forget chain below. */
function applicableConnectOffsetMs(
  state: RunnerSessionState,
  instanceId: string,
  waveConnect: boolean | undefined,
): number {
  if (state.linkState !== 'linked' || !waveConnect) {
    return 0;
  }
  return instanceConnectOffsetMs(instanceId);
}

/**
 * P09 fleet-recovery FIX - the single deferred, cancellable wait helper both
 * the lease's takeover grace (`state.lease.graceMs`) and the U6b connect-
 * offset wait (`applicableConnectOffsetMs()`) share, so `teardown()`'s ONE
 * `clearPendingOffset()` call cancels whichever of the two is currently
 * pending without needing a second timer field. Resolves immediately for
 * `delayMs <= 0`. Returns the resolver so the caller's `clearPendingOffset`
 * can settle it early on a racing teardown/drain.
 */
function waitDeferred(
  deps: Pick<CreateSessionRunnerDeps, 'setTimeoutFn'>,
  state: RunnerSessionState,
  setResolvePendingOffset: (resolve: (() => void) | undefined) => void,
  delayMs: number,
): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    setResolvePendingOffset(resolve);
    state.pendingOffsetTimer = deps.setTimeoutFn(() => {
      state.pendingOffsetTimer = undefined;
      setResolvePendingOffset(undefined);
      resolve();
    }, delayMs);
  });
}

/**
 * Runs the deferred-open chain as a fire-and-forget task (the caller is
 * expected to `void` this call, exactly as `start()` used to `void` the
 * inline IIFE). `setResolvePendingOffset` lets the caller's own
 * `clearPendingOffset()` cancel whichever wait is currently pending (same
 * single-field sharing `waitDeferred` always used).
 */
export async function runDeferredSocketOpen(
  input: WaitForDeferredSocketOpenInput,
  setResolvePendingOffset: (resolve: (() => void) | undefined) => void,
): Promise<void> {
  const { deps, state, instanceId, waveConnect, connectGateAbortController, buildAndWireSocket } =
    input;

  const controller = connectGateAbortController();
  try {
    await deps.connectGate.take({ signal: controller.signal });
  } catch {
    // Aborted by teardown/drain (CRITICAL 3) - never open a socket for
    // a session already torn down. Any OTHER connect-gate error is
    // fail-safe (core invariant 2): never proceed to buildAndWireSocket.
    return;
  }
  if (state.tornDown || state.ended) {
    // A teardown/drain raced the connect-gate wait - never open a
    // socket for a session already torn down.
    return;
  }
  if (state.lease.graceMs > 0) {
    await waitDeferred(deps, state, setResolvePendingOffset, state.lease.graceMs);
    if (state.tornDown || state.ended) {
      // A teardown/drain raced the grace wait (clearPendingOffset
      // resolved it early) - never open a socket for a session
      // already torn down.
      return;
    }
  }
  const offsetMs = applicableConnectOffsetMs(state, instanceId, waveConnect);
  if (offsetMs > 0) {
    await waitDeferred(deps, state, setResolvePendingOffset, offsetMs);
  }
  if (state.tornDown || state.ended) {
    // A teardown/drain raced one of the deferred waits
    // (clearPendingOffset resolved it early) - never open a socket
    // for a session already torn down.
    return;
  }
  try {
    await buildAndWireSocket();
  } catch (err) {
    // Fail-safe: a rejecting first open (creds load, socket factory)
    // must not escape this fire-and-forget chain as an unhandled
    // rejection. Ids only - no payloads.
    deps.logger.warn('deferred socket open failed', {
      instanceId: state.instanceId,
      clientId: state.clientId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
