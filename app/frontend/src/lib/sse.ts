import type { QueryClient } from '@tanstack/react-query';
import { ensureSession as sharedEnsureSession } from './api-client.js';
import {
  notifyState,
  runConnectionLoop,
  type SharedConnection,
} from './sse-connection.js';
import type { RealtimeConnectionState } from './sse-types.js';

export { subscribeRealtimeEvent } from './sse-event-registry.js';
export type { RealtimeConnectionState } from './sse-types.js';

/**
 * lib/sse.ts (P05 U5, phase step 8) - the ONE always-on, client-wide
 * realtime stream a browser tab keeps open (`GET /v1/events`, no query
 * string, ever - the app-shell-level connection every panel route shares).
 * ADR 0010 / phase decision: `EventSource` cannot carry a Bearer header, so
 * this opens the stream with `fetch()` + `Authorization: Bearer` +
 * `credentials: 'include'`, parses the `ReadableStream` as SSE frames by
 * hand (`lib/sse-frame-parser.ts`), and on a hint frame invalidates the
 * STATIC query key(s) from `lib/sse-invalidation-map.ts` - it never trusts
 * the frame's payload as data (canon: "the client receives a hint and
 * refetches over the authorized API").
 *
 * The reconnect loop itself (backoff, 401 handling, `Last-Event-ID` resume,
 * the `shared === mine` identity-guard pattern) now lives in
 * `sse-connection.ts` (split out for the workspace's 300-line max-lines
 * rule, and reused as-is by `sse-instance-stream.ts` - see that file's
 * header comment for why the Connect sheet's QR/pairing stream is a SECOND,
 * separately-scoped connection rather than a reconnect of THIS singleton
 * with an added query string).
 *
 * Module-level ref-counted singleton: React 19 StrictMode double-mounts an
 * effect in dev (mount -> cleanup -> remount), and two real route trees
 * (e.g. AppShell mounted twice during a fast navigation) must never open two
 * independent streams for the same session - `acquireRealtimeConnection`/
 * `release()` share ONE underlying connection, keyed by module state (which
 * survives a StrictMode remount; a ref would not - see
 * `features/auth/components/once-per-token.ts`'s doc comment for the same
 * pattern applied to a different problem).
 *
 * `subscribeRealtimeEvent` (P08 U7, re-exported from `sse-event-registry.ts`
 * - split out for the workspace's 300-line max-lines rule) is this file's
 * ADDITIVE typed listener registry: `connectOnce` dispatches every parsed,
 * known-type event to it, right after the static invalidation map runs. The
 * registry is scope-agnostic - it also receives frames from any
 * instance-scoped connection `sse-instance-stream.ts` opens.
 */

const EVENTS_PATH = '/v1/events';

export interface AcquireRealtimeOptions {
  queryClient: QueryClient;
  /** Injectable RNG for full-jitter backoff, default `Math.random`. */
  random?: () => number;
  /** Injectable shared-refresh check, default `ensureSession` from api-client.ts. */
  ensureSession?: () => Promise<boolean>;
  /** Injectable connection-state observer (for the AppShell realtime chip). */
  onStateChange?: (state: RealtimeConnectionState) => void;
  /** Test seam: observes each scheduled reconnect delay in ms. */
  onReconnectScheduled?: (delayMs: number) => void;
}

export interface RealtimeConnectionHandle {
  release: () => void;
}

let shared: SharedConnection | null = null;

/**
 * Acquires (creating if necessary) the ONE shared client-wide realtime
 * connection for this tab. Returns a handle whose `release()` decrements the
 * ref count; the underlying `fetch` stream is only aborted when the count
 * reaches zero.
 */
export function acquireRealtimeConnection(
  options: AcquireRealtimeOptions,
): RealtimeConnectionHandle {
  const random = options.random ?? Math.random;
  const ensureSession = options.ensureSession ?? sharedEnsureSession;
  const onStateChange = options.onStateChange ?? (() => undefined);
  const onReconnectScheduled = options.onReconnectScheduled ?? (() => undefined);

  if (!shared) {
    shared = {
      path: EVENTS_PATH,
      refCount: 0,
      abortController: new AbortController(),
      lastEventId: undefined,
      stateListeners: new Set(),
    };
    const mine = shared;
    void runConnectionLoop(
      {
        queryClient: options.queryClient,
        random,
        ensureSession,
        onReconnectScheduled,
        getShared: () => shared,
        onStateChange: (state) => notifyState(mine, state),
      },
      mine,
    );
  }

  shared.refCount += 1;
  shared.stateListeners.add(onStateChange);

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      if (!shared) return;
      shared.stateListeners.delete(onStateChange);
      shared.refCount -= 1;
      if (shared.refCount <= 0) {
        shared.abortController.abort();
        shared = null;
      }
    },
  };
}

/** Test-only reset - never called from production code. */
export function resetRealtimeConnectionForTests(): void {
  if (shared) {
    shared.abortController.abort();
    shared = null;
  }
}
