import type {
  AuthStoreLike,
  CreateSessionRunnerDeps,
  CredsSaveBufferPort,
  FakeableSocket,
  RunnerSessionState,
} from './runner-types.js';

/**
 * runner-creds-update.ts (FIX-A, P26 C1 review CRITICAL 1) - the real
 * Baileys `creds.update` event's fail-safe boundary, split out of runner.ts
 * for the max-lines cap. Mirrors `runner-connection-update.ts#
 * onConnectionUpdateSafe` exactly: a `creds.update` listener must NEVER leak
 * a rejection into Baileys' own event emitter, or an unhandled rejection
 * kills the whole worker process (up to `sessionCap` co-hosted sessions).
 *
 * `credsSaveBuffer.save()` and the buffer's own retry-timer `flush()`
 * rethrow every NON-PG-unavailable error by design (see
 * `creds-save-buffer.ts`'s header): a fence conflict/`StoreFencedError`
 * means the store has ALREADY self-fenced (or is already fenced) - warn and
 * return, never a second teardown (the store's own `selfFence` already ran
 * `onFenceConflict`/`releaseLease`). Any OTHER error (`CredsSaveExhaustedError`,
 * decrypt/codec, unknown) gets the SAME fail-safe response as a
 * `connection.update` handler failure: warn, then `teardown({ release:
 * false })` - stop rather than retry blindly (core invariant 2), and never
 * release a lease whose fate is unclear.
 */

export interface RunnerCredsUpdateContext {
  deps: CreateSessionRunnerDeps;
  state: RunnerSessionState;
  credsSaveBuffer: CredsSaveBufferPort;
  teardown: (options: { release: boolean }) => Promise<void>;
}

function isSelfFencedError(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === 'StoreFencedError' || err.name === 'FenceConflictError')
  );
}

/** Bound to ONE socket generation - a stray save for an already-torn-down/stale generation is still routed through the SAME fail-safe boundary (never assumed safe to skip: the buffer itself has no generation concept, so this is the only place that could apply one, and applying `state.ended`/generation guards here would risk swallowing a real conflict on the CURRENT generation - the boundary below already makes every outcome safe either way). */
export async function onCredsUpdateSafe(
  ctx: RunnerCredsUpdateContext,
  creds: unknown,
): Promise<void> {
  const { deps, state, credsSaveBuffer, teardown } = ctx;
  try {
    // FIX-P26-G (round-2 review CRITICAL A): `save()` resolves `{ credVersion }`
    // on a real passthrough save, `undefined` when the call only buffered the
    // entry - advancing `state.credVersion` only in the former case is what
    // makes every SUBSEQUENT `creds.update`'s `expectedVersion` target the
    // fast (non-conflict) path instead of replaying the same stale version.
    const result = await credsSaveBuffer.save({
      creds,
      expectedVersion: state.credVersion,
      fence: state.lease.fence,
    });
    if (result) {
      state.credVersion = result.credVersion;
    }
  } catch (err) {
    if (isSelfFencedError(err)) {
      deps.logger.warn('creds.update ignored: store fenced', {
        instanceId: state.instanceId,
        clientId: state.clientId,
      });
      return;
    }
    deps.logger.warn('creds.update handler failed: tearing down without release', {
      instanceId: state.instanceId,
      clientId: state.clientId,
    });
    await teardown({ release: false });
  }
}

/**
 * Wired to `credsSaveBuffer`'s `onError` port (its retry timer's own
 * scheduled `flush()` has no caller to propagate a rejection to) - routes
 * through the SAME classify-then-respond boundary as a live `save()` failure
 * above, so a fence conflict discovered by the timer warns exactly once and
 * any other error still tears the runner down without release.
 */
export function onCredsFlushError(ctx: RunnerCredsUpdateContext, err: unknown): void {
  const { deps, state, teardown } = ctx;
  if (isSelfFencedError(err)) {
    deps.logger.warn('creds.update flush ignored: store fenced', {
      instanceId: state.instanceId,
      clientId: state.clientId,
    });
    return;
  }
  deps.logger.warn('creds.update flush failed: tearing down without release', {
    instanceId: state.instanceId,
    clientId: state.clientId,
  });
  void teardown({ release: false });
}

/** FIX-A (P26 C1 review, MAJOR 6) - the teardown flush's own budget; see `runTeardownFlush`'s doc. */
const TEARDOWN_FLUSH_BUDGET_MS = 1000;

/**
 * Bounded, best-effort teardown flush - split out of runner.ts's `teardown()`
 * purely for the max-lines cap. A teardown flush with no bound of its own can
 * cost up to `pgConnectTimeoutMs` (+ up to 3 store retries x
 * `pgStatementTimeoutMs` when PG is only partially up) - on a 100-session
 * worker that can burn the WHOLE drain deadline before `leaseManager.release`
 * ever runs for later sessions. `unavailable()` true means PG is ALREADY
 * known-down (the buffer's stated bounded-loss semantics apply - skip the
 * doomed attempt entirely); otherwise race the flush against a short budget
 * so a slow-but-live PG still gets a chance without blocking the drain queue
 * behind it. Either way the failure (including the budget's own timeout) is
 * swallowed - teardown must never hang/throw on unclear PG.
 */
export async function runTeardownFlush(
  credsSaveBuffer: CredsSaveBufferPort,
  setTimeoutFn: (fn: () => void, ms: number) => unknown,
): Promise<void> {
  if (credsSaveBuffer.unavailable()) {
    return;
  }
  await Promise.race([
    credsSaveBuffer.flush().catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeoutFn(resolve, TEARDOWN_FLUSH_BUDGET_MS);
    }),
  ]);
}

/**
 * FIX-A (P26 C1 review, CRITICAL 1): resolves the seeded `cred_version` on
 * the FIRST call only (a `seeded` flag the caller owns, since a reconnect
 * must reuse the already-current in-memory value), else `undefined` -
 * `undefined` deliberately means "nothing to await", not "seed with 0n": the
 * caller (`runner.ts#buildAndWireSocket`) only `await`s the returned Promise
 * when it is NOT `undefined`, so the already-seeded (reconnect) path adds
 * ZERO extra microtask turns before this generation's listeners are wired -
 * a fire-and-forget reconnect-timer callback has no caller to await one.
 */
export function seedCredVersionOnceIfNeeded(
  authStore: AuthStoreLike,
  seeded: { done: boolean },
): Promise<bigint> | undefined {
  if (seeded.done) {
    return undefined;
  }
  seeded.done = true;
  return Promise.resolve(authStore.currentCredVersion?.() ?? 0n);
}

/** Wires the real Baileys `creds.update` event through the fail-safe boundary above - split out of runner.ts's `buildAndWireSocket` purely for the max-lines cap. No-op when `credsSaveBuffer` is absent (fail-safe default: no listener registered). */
export function wireCredsUpdateListener(
  ctx: RunnerCredsUpdateContext,
  sock: Pick<FakeableSocket, 'ev'>,
  creds: unknown,
): void {
  sock.ev.on('creds.update', () => {
    void onCredsUpdateSafe(ctx, creds);
  });
}

/**
 * Builds the `AuthStorePortsLike.onCredsSaveBufferError` closure `runner.ts`
 * passes into `buildAuthStore` - a genuine forward reference (the port is
 * passed INTO the same call that produces `credsSaveBuffer`), so it closes
 * over a mutable ref the caller populates via the returned setter right
 * after that call returns, rather than the call's own return value.
 */
export function buildOnCredsSaveBufferError(
  deps: CreateSessionRunnerDeps,
  state: RunnerSessionState,
  teardown: (options: { release: boolean }) => Promise<void>,
): {
  onCredsSaveBufferError: (err: unknown) => void;
  setCredsSaveBuffer: (buffer: CredsSaveBufferPort | undefined) => void;
} {
  let credsSaveBufferRef: CredsSaveBufferPort | undefined;
  return {
    onCredsSaveBufferError: (err: unknown) => {
      if (credsSaveBufferRef) {
        onCredsFlushError({ deps, state, credsSaveBuffer: credsSaveBufferRef, teardown }, err);
      }
    },
    setCredsSaveBuffer: (buffer) => {
      credsSaveBufferRef = buffer;
    },
  };
}
