import type { QueryClient } from '@tanstack/react-query';
import {
  ensureSession as sharedEnsureSession,
  getAccessToken,
  setAccessToken,
} from './api-client.js';
import { consumeStream } from './sse-stream-consumer.js';
import { dispatchRealtimeEvent } from './sse-event-registry.js';

export { subscribeRealtimeEvent } from './sse-event-registry.js';

/**
 * lib/sse.ts (P05 U5, phase step 8) - the ONE realtime stream a browser tab
 * keeps open. ADR 0010 / phase decision: `EventSource` cannot carry a
 * Bearer header, so this opens `GET /v1/events` with `fetch()` +
 * `Authorization: Bearer` + `credentials: 'include'`, parses the
 * `ReadableStream` as SSE frames by hand (`lib/sse-frame-parser.ts`), and on
 * a hint frame invalidates the STATIC query key(s) from
 * `lib/sse-invalidation-map.ts` - it never trusts the frame's payload as
 * data (canon: "the client receives a hint and refetches over the
 * authorized API").
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
 * ADDITIVE typed listener registry: `connectOnce` below dispatches every
 * parsed, known-type event to it via `dispatchRealtimeEvent`, right after
 * the static invalidation map runs.
 */

const EVENTS_PATH = '/v1/events';
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

export type RealtimeConnectionState = 'live' | 'reconnecting' | 'offline';

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

interface SharedConnection {
  refCount: number;
  abortController: AbortController;
  lastEventId: string | undefined;
  stateListeners: Set<(state: RealtimeConnectionState) => void>;
}

let shared: SharedConnection | null = null;

function setState(state: RealtimeConnectionState): void {
  if (!shared) return;
  for (const listener of shared.stateListeners) {
    listener(state);
  }
}

function fullJitterDelay(attempt: number, random: () => number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return random() * ceiling;
}

interface ConnectionLoopOptions {
  queryClient: QueryClient;
  random: () => number;
  ensureSession: () => Promise<boolean>;
  onReconnectScheduled: (delayMs: number) => void;
}

/** One connect attempt: returns `'reauth'` on 401 (caller retries immediately), else resolves when the stream ends. */
async function connectOnce(
  opts: ConnectionLoopOptions,
  controller: AbortController,
  mine: SharedConnection,
): Promise<'reauth' | 'done'> {
  const token = getAccessToken();
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (mine.lastEventId) headers['Last-Event-ID'] = mine.lastEventId;

  const response = await fetch(EVENTS_PATH, {
    method: 'GET',
    credentials: 'include',
    headers,
    signal: controller.signal,
  });

  if (shared !== mine) {
    // A release()+reacquire() raced this fetch while it was in flight -
    // `mine` is no longer the live shared connection. Treat this exactly
    // like an abort: stop, never touch state/headers belonging to whatever
    // connection replaced it.
    throw new DOMException('superseded', 'AbortError');
  }

  if (response.status === 401) {
    setState('reconnecting');
    // The token just used above was rejected - `ensureSession()`'s default
    // implementation treats a STALE-but-present in-memory token as an
    // immediate success (`if (accessToken) return true`), which would skip
    // the refresh entirely and hand this exact bad token right back. Clear
    // it first so `ensureSession()` always performs a real refresh here.
    setAccessToken(null);
    const ok = await opts.ensureSession();
    if (shared !== mine) {
      throw new DOMException('superseded', 'AbortError');
    }
    if (!ok) {
      setState('offline');
      throw new DOMException('session unavailable', 'AbortError');
    }
    return 'reauth';
  }

  if (!response.ok || !response.body) {
    throw new Error(`SSE connect failed: ${String(response.status)}`);
  }

  setState('live');
  await consumeStream(
    response,
    opts.queryClient,
    (id) => {
      // Identity guard: `mine` is the SharedConnection this specific
      // connection loop was started for, captured once at loop start (see
      // `runConnectionLoop`'s doc comment). A `release()` + immediate
      // `acquire()` racing this exact frame callback must never write
      // `lastEventId` onto a DIFFERENT (newer) shared connection object, nor
      // resurrect a stale one after `shared` has moved on.
      if (shared === mine) {
        mine.lastEventId = id;
      }
    },
    (event) => {
      // Same identity guard as above, applied to the typed listener
      // registry: a superseded connection must never dispatch events to
      // subscribers registered against the CURRENT (possibly different)
      // shared connection's lifetime.
      if (shared === mine) {
        dispatchRealtimeEvent(event);
      }
    },
  );
  return 'done';
}

/** Consecutive same-tick 'reauth' outcomes allowed before backoff kicks in (one legitimate refresh-then-retry hop). */
const MAX_IMMEDIATE_REAUTH_RETRIES = 1;

/**
 * Runs ONE connection loop generation. `mine` is captured ONCE here (the
 * `SharedConnection` this call was launched for by `acquireRealtimeConnection`)
 * - every continuation check below re-reads the module-level `shared` and
 * compares it by IDENTITY (`shared === mine`), never merely truthiness.
 *
 * Why identity and not truthiness: `release()` (refCount -> 0) nulls
 * `shared`, and an immediately following `acquire()` (e.g. a fast
 * navigation's remount) creates a BRAND NEW `SharedConnection` object and
 * starts a brand new loop generation. If this (older) loop is asleep in its
 * backoff `setTimeout` at that exact moment, waking up to `while (shared)`
 * alone would see the NEW object (truthy) and wrongly keep running - two
 * concurrent streams for one tab. Comparing against the captured `mine`
 * catches that: once `shared !== mine`, this generation exits for good,
 * regardless of what (if anything) replaced it.
 */
async function runConnectionLoop(
  opts: ConnectionLoopOptions,
  mine: SharedConnection,
): Promise<void> {
  let attempt = 0;
  let consecutiveReauths = 0;

  while (shared === mine) {
    const controller = mine.abortController;

    try {
      const outcome = await connectOnce(opts, controller, mine);
      if (shared !== mine) return;
      if (outcome === 'reauth') {
        consecutiveReauths += 1;
        // A single successful refresh-then-retry is the common case and
        // must stay immediate (no user-visible delay) - `attempt` (the
        // backoff exponent) is intentionally NOT touched on this immediate
        // path. But if the server keeps returning 401 even after
        // `ensureSession()` reports success (stale-refresh race, a session
        // that is revoked server-side right after refreshing, etc.),
        // retrying with zero delay forever is an unbounded synchronous spin
        // - once the immediate-retry budget is exhausted, fall through to
        // the SAME backoff path a network failure takes below, without
        // resetting `attempt` back to 0 first (a reset here would make every
        // failed reauth pass indistinguishable from a fresh, first-ever
        // failure and defeat the backoff's exponential growth).
        if (consecutiveReauths <= MAX_IMMEDIATE_REAUTH_RETRIES) {
          continue;
        }
      } else {
        attempt = 0;
        consecutiveReauths = 0;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (shared !== mine) return;
      void error; // fall through to reconnect below
    }

    if (shared !== mine) return;

    setState('reconnecting');
    const delayMs = fullJitterDelay(attempt, opts.random);
    opts.onReconnectScheduled(delayMs);
    attempt += 1;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });

    if (shared !== mine) return;
  }
}

/**
 * Acquires (creating if necessary) the ONE shared realtime connection for
 * this tab. Returns a handle whose `release()` decrements the ref count;
 * the underlying `fetch` stream is only aborted when the count reaches
 * zero.
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
