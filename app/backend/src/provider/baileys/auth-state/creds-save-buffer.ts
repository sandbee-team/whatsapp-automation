import { isPgUnavailableError } from './pg-unavailable.js';

/**
 * creds-save-buffer.ts (P26 U6a, step 6 chaos: Postgres outage) -
 * `createCredsSaveBuffer`: wraps `EncryptedAuthStore.saveCreds` from the
 * OUTSIDE so a Postgres availability failure buffers creds saves (bounded,
 * newest-wins) instead of losing them or blocking the socket - canon (ADR
 * 0018 S4, scope-delta "what breaks first" #12): "a Postgres availability
 * failure buffers creds saves (bounded, max 8, newest-wins) and keeps
 * sockets up while sends stop; ONLY a fence conflict self-fences."
 *
 * This module NEVER classifies fence/epoch conflicts, NEVER calls a
 * self-fence port, and NEVER imports `@wp/server-kit` - logger/metrics/timer
 * are all injected ports (`CredsSaveBufferPorts`), same discipline as
 * `store.ts`'s own three escape hatches. Every non-PG-unavailable error from
 * `saveCreds` (a live save OR a flush) is rethrown UNTOUCHED - the store's
 * own self-fence path (inside `saveCreds` itself) is the only self-fence
 * path anywhere in this feature; this buffer only ever decides "buffer it"
 * vs "let it through/rethrow it".
 */

export const CREDS_SAVE_BUFFER_MAX = 8;

export interface BufferedCredsSave {
  creds: unknown;
  expectedVersion: bigint;
  fence: bigint;
  enqueuedAtMs: number;
  seq: number;
}

export type CredsSaveBufferEventKind =
  'buffered' | 'dropped' | 'flushed' | 'flush_failed_pg_unavailable';

export interface CredsSaveBufferEvent {
  kind: CredsSaveBufferEventKind;
  seq?: number;
  buffered: number;
}

export interface CredsSaveBufferPorts {
  /**
   * The real `store.saveCreds` (or an equivalent) - called directly while
   * healthy, and by `flush()` for the newest buffered entry. FIX-P26-G:
   * resolves the store's freshly-written `credVersion` (it already produces
   * one - see `store.ts#saveCredsAttempt`) so the buffer can hand it back to
   * its caller instead of discarding it.
   */
  saveCreds: (args: {
    creds: unknown;
    expectedVersion: bigint;
    fence: bigint;
  }) => Promise<{ credVersion: bigint }>;
  /** Classifies a thrown error as "Postgres is unavailable" - `isPgUnavailableError` from `pg-unavailable.ts` in production. */
  isPgUnavailable: (err: unknown) => boolean;
  /**
   * FIX-P26-G - resolves the runner's CURRENT `state.credVersion` at the
   * exact moment `flush()` runs (never at enqueue time): a buffered entry
   * may sit for minutes while `onOpen`/another `creds.update` save advances
   * the real version, so replaying the version captured when the entry was
   * PUSHED would definitionally target a stale `expectedVersion`. Required
   * (no default) - every real caller has a `state.credVersion` to read.
   */
  readExpectedVersion: () => bigint;
  now: () => number;
  /** Injected timer port - production wiring uses a real `setTimeout(...).unref()`; tests capture the callback directly. */
  schedule: (fn: () => void, ms: number) => { cancel(): void };
  /** Retry interval in ms between a buffered entry and the next flush attempt. Defaults to 5000. */
  retryMs?: number;
  /** Structured, ids-only observability hook - never receives creds content. */
  onEvent?: (e: CredsSaveBufferEvent) => void;
  /**
   * FIX-A (P26 C1 review) - the retry timer's own scheduled `flush()` call is
   * fire-and-forget (`armRetry` cannot await it); WITHOUT this port, any
   * error `flush()` rethrows (a fence conflict, `StoreFencedError`,
   * `CredsSaveExhaustedError` - every non-PG-unavailable class, by design,
   * see this module's header) becomes an unhandled rejection and, under
   * Node's default, kills the whole worker process. Called with the raw
   * thrown value; never invoked for a PG-unavailable flush failure (that
   * outcome is the buffer's own normal "stay buffered, re-arm" path, not an
   * error the caller needs to react to). Omitted means the caller accepts
   * the pre-existing risk (no runner ever omits it - see
   * `session-worker-runner-factory.ts`'s wiring).
   */
  onError?: (err: unknown) => void;
  /**
   * FIX-P26-G - called with the resolved `credVersion` exactly when ANY
   * `flush()` call applies (including the retry timer's own fire-and-forget
   * one, which has no other way to hand a result back to its caller). The
   * runner uses this to advance `state.credVersion` after a buffered save
   * finally lands - without it, a save buffered during a PG outage and later
   * flushed by the retry timer would leave the runner's tracked version
   * stale until the NEXT `connection.update` 'open' event. Omitted means the
   * caller does not need the resolved version (e.g. a test exercising only
   * the buffer's own bounded-loss behaviour).
   */
  onFlushed?: (credVersion: bigint) => void;
}

export interface FlushResult {
  applied: boolean;
  remaining: number;
  /** FIX-P26-G - set exactly when `applied: true`; the resolved `credVersion` the caller should advance its own tracked version to. */
  credVersion?: bigint;
}

export interface CredsSaveBuffer {
  /** FIX-P26-G - resolves `undefined` when this call only buffered the entry (nothing was persisted, so there is no new version to advance to); resolves `{ credVersion }` on a real passthrough save. */
  save(args: {
    creds: unknown;
    expectedVersion: bigint;
    fence: bigint;
  }): Promise<{ credVersion: bigint } | undefined>;
  flush(): Promise<FlushResult>;
  size(): number;
  dropped(): number;
  unavailable(): boolean;
  /** Cancels the pending retry timer only - never flushes, never clears the buffer. */
  dispose(): void;
}

const DEFAULT_RETRY_MS = 5000;

/**
 * Builds a `CredsSaveBuffer` bound to `ports`. Exactly one pending retry
 * timer exists at a time (armed on the first buffered entry after recovery
 * from an empty/healthy state, and re-armed by a failed flush) - never a
 * thundering herd of independent timers per buffered save.
 */
export function createCredsSaveBuffer(ports: CredsSaveBufferPorts): CredsSaveBuffer {
  const retryMs = ports.retryMs ?? DEFAULT_RETRY_MS;
  const buffer: BufferedCredsSave[] = [];
  let seqCounter = 0;
  let droppedCount = 0;
  let pendingTimer: { cancel(): void } | undefined;
  // Decoupled from `buffer.length`: true only while the LAST observed
  // outcome was a PG-unavailable error - a fence conflict (or any other
  // non-PG error) during `flush()` clears this WITHOUT clearing the
  // buffered entries themselves (spec: "clear nothing, set unavailable()
  // false"), because the underlying condition is no longer "PG is down",
  // it is "this store is now fenced" - retrying would just rethrow forever.
  let unavailableFlag = false;

  function emit(kind: CredsSaveBufferEventKind, seq?: number): void {
    ports.onEvent?.({ kind, seq, buffered: buffer.length });
  }

  function armRetry(): void {
    if (pendingTimer) {
      return;
    }
    pendingTimer = ports.schedule(() => {
      pendingTimer = undefined;
      // FIX-A (P26 C1 review, MAJOR/CRITICAL 1): `flush()` rethrows every
      // non-PG-unavailable error by design - this scheduled call has no
      // caller to propagate to, so `onError` is the only boundary standing
      // between a fence conflict here and an unhandled rejection.
      void flush().catch((err: unknown) => ports.onError?.(err));
    }, retryMs);
  }

  function pushBuffered(args: { creds: unknown; expectedVersion: bigint; fence: bigint }): void {
    seqCounter += 1;
    const entry: BufferedCredsSave = {
      creds: args.creds,
      expectedVersion: args.expectedVersion,
      fence: args.fence,
      enqueuedAtMs: ports.now(),
      seq: seqCounter,
    };
    buffer.push(entry);
    unavailableFlag = true;
    if (buffer.length > CREDS_SAVE_BUFFER_MAX) {
      buffer.shift();
      droppedCount += 1;
      emit('dropped', entry.seq);
    } else {
      emit('buffered', entry.seq);
    }
    armRetry();
  }

  async function save(args: {
    creds: unknown;
    expectedVersion: bigint;
    fence: bigint;
  }): Promise<{ credVersion: bigint } | undefined> {
    if (unavailableFlag) {
      // Already unavailable - go straight into the buffer, never hit PG
      // again (no thundering herd of live attempts alongside the retry timer).
      pushBuffered(args);
      return undefined;
    }
    try {
      return await ports.saveCreds(args);
    } catch (err) {
      if (!ports.isPgUnavailable(err)) {
        throw err;
      }
      pushBuffered(args);
      return undefined;
    }
  }

  async function flush(): Promise<FlushResult> {
    if (buffer.length === 0) {
      return { applied: false, remaining: 0 };
    }
    const newest = buffer[buffer.length - 1] as BufferedCredsSave;
    // FIX-P26-G - the version is resolved NOW, not the stale value snapshotted
    // at enqueue time (see `readExpectedVersion`'s own doc comment).
    const expectedVersion = ports.readExpectedVersion();
    let result: { credVersion: bigint };
    try {
      result = await ports.saveCreds({
        creds: newest.creds,
        expectedVersion,
        fence: newest.fence,
      });
    } catch (err) {
      if (ports.isPgUnavailable(err)) {
        armRetry();
        emit('flush_failed_pg_unavailable', newest.seq);
        return { applied: false, remaining: buffer.length };
      }
      // A non-PG-unavailable error (e.g. a fence conflict) during flush
      // self-fences via the store exactly as a live save would - never
      // re-buffered, never swallowed. Spec: "clear nothing, set
      // unavailable() false" - the entries stay in `buffer` (forensic/
      // introspection only; this store is fenced now, nothing will ever
      // successfully flush them), but this is no longer a PG-availability
      // condition, so the flag comes down and no further retry is armed.
      unavailableFlag = false;
      throw err;
    }
    buffer.length = 0;
    unavailableFlag = false;
    emit('flushed', newest.seq);
    ports.onFlushed?.(result.credVersion);
    return { applied: true, remaining: 0, credVersion: result.credVersion };
  }

  return {
    save,
    flush,
    size: () => buffer.length,
    dropped: () => droppedCount,
    unavailable: () => unavailableFlag,
    dispose(): void {
      pendingTimer?.cancel();
      pendingTimer = undefined;
    },
  };
}

export { isPgUnavailableError };
