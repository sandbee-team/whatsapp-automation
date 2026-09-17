import type { QueryClient } from '@tanstack/react-query';
import { getAccessToken, setAccessToken } from './api-client.js';
import { consumeStream } from './sse-stream-consumer.js';
import { dispatchRealtimeEvent } from './sse-event-registry.js';
import type { RealtimeConnectionState } from './sse-types.js';

/**
 * lib/sse-connection.ts (split out of sse.ts for the workspace's 300-line
 * max-lines rule, ahead of P08's fix for "QR never reaches the browser" -
 * see sse-instance-stream.ts's header comment for the full incident writeup)
 * - the generic one-connection reconnect loop (full-jitter backoff, 401 ->
 * shared-refresh -> retry, `Last-Event-ID` resume, the `shared === mine`
 * identity-guard pattern) with NO knowledge of which URL it is fetching or
 * which module-level singleton var holds it.
 *
 * Both `sse.ts` (the one always-on, client-wide stream every AppShell mount
 * shares) and `sse-instance-stream.ts` (the additional, transient,
 * instance-scoped stream the Connect sheet opens - see that file's header
 * comment for why this is a SECOND connection rather than a reconnect of the
 * first) build on this exact same loop. Extracting it here means the fiddly
 * concurrency reasoning in `runConnectionLoop`'s doc comment (why identity,
 * not truthiness) is proven once and reused twice, rather than forked and
 * risking the two copies drifting apart.
 */

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

export function fullJitterDelay(attempt: number, random: () => number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return random() * ceiling;
}

/**
 * The mutable state one connection loop generation owns. `path` is baked in
 * at creation time (e.g. `/v1/events` or `/v1/events?instanceId=...`) - a
 * loop never changes its own URL mid-flight; a caller that needs a different
 * scope starts a NEW `SharedConnection` (a new loop generation) instead, so
 * `shared === mine` identity guards keep working unmodified for callers that
 * key their own module-level `shared` var by scope (see
 * `sse-instance-stream.ts`).
 */
export interface SharedConnection {
  path: string;
  refCount: number;
  abortController: AbortController;
  lastEventId: string | undefined;
  stateListeners: Set<(state: RealtimeConnectionState) => void>;
}

export function notifyState(
  connection: SharedConnection | null,
  state: RealtimeConnectionState,
): void {
  if (!connection) return;
  for (const listener of connection.stateListeners) {
    listener(state);
  }
}

export interface ConnectionLoopOptions {
  queryClient: QueryClient;
  random: () => number;
  ensureSession: () => Promise<boolean>;
  onReconnectScheduled: (delayMs: number) => void;
  /** Reads the module-level `shared` var this loop generation belongs to - see `runConnectionLoop`'s doc comment on why identity, not truthiness, gates every continuation. */
  getShared: () => SharedConnection | null;
  onStateChange: (state: RealtimeConnectionState) => void;
}

/** One connect attempt: returns `'reauth'` on 401 (caller retries immediately), else resolves when the stream ends. */
export async function connectOnce(
  opts: ConnectionLoopOptions,
  controller: AbortController,
  mine: SharedConnection,
): Promise<'reauth' | 'done'> {
  const token = getAccessToken();
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (mine.lastEventId) headers['Last-Event-ID'] = mine.lastEventId;

  const response = await fetch(mine.path, {
    method: 'GET',
    credentials: 'include',
    headers,
    signal: controller.signal,
  });

  if (opts.getShared() !== mine) {
    // A release()+reacquire() raced this fetch while it was in flight -
    // `mine` is no longer the live shared connection for this scope. Treat
    // this exactly like an abort: stop, never touch state/headers belonging
    // to whatever connection replaced it.
    throw new DOMException('superseded', 'AbortError');
  }

  if (response.status === 401) {
    opts.onStateChange('reconnecting');
    // The token just used above was rejected - `ensureSession()`'s default
    // implementation treats a STALE-but-present in-memory token as an
    // immediate success (`if (accessToken) return true`), which would skip
    // the refresh entirely and hand this exact bad token right back. Clear
    // it first so `ensureSession()` always performs a real refresh here.
    setAccessToken(null);
    const ok = await opts.ensureSession();
    if (opts.getShared() !== mine) {
      throw new DOMException('superseded', 'AbortError');
    }
    if (!ok) {
      opts.onStateChange('offline');
      throw new DOMException('session unavailable', 'AbortError');
    }
    return 'reauth';
  }

  if (!response.ok || !response.body) {
    throw new Error(`SSE connect failed: ${String(response.status)}`);
  }

  opts.onStateChange('live');
  await consumeStream(
    response,
    opts.queryClient,
    (id) => {
      // Identity guard: `mine` is the SharedConnection this specific
      // connection loop was started for, captured once at loop start (see
      // `runConnectionLoop`'s doc comment). A `release()` + immediate
      // `acquire()` racing this exact frame callback must never write
      // `lastEventId` onto a DIFFERENT (newer) shared connection object, nor
      // resurrect a stale one after the module's `shared` var has moved on.
      if (opts.getShared() === mine) {
        mine.lastEventId = id;
      }
    },
    (event) => {
      // Same identity guard as above, applied to the typed listener
      // registry: a superseded connection must never dispatch events to
      // subscribers registered against the CURRENT (possibly different)
      // shared connection's lifetime. The registry itself is global and
      // scope-agnostic (sse-event-registry.ts) - both the client-wide stream
      // and any instance-scoped stream feed the SAME registry, which is
      // exactly what lets `useLinkStream` keep calling `subscribeRealtimeEvent`
      // without caring which physical connection the frame arrived on.
      if (opts.getShared() === mine) {
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
 * `SharedConnection` this call was launched for) - every continuation check
 * below re-reads `opts.getShared()` and compares it by IDENTITY
 * (`=== mine`), never merely truthiness.
 *
 * Why identity and not truthiness: `release()` (refCount -> 0) nulls the
 * scope's module-level `shared` var, and an immediately following
 * `acquire()` (e.g. a fast navigation's remount, or the Connect sheet
 * closing and reopening) creates a BRAND NEW `SharedConnection` object and
 * starts a brand new loop generation. If this (older) loop is asleep in its
 * backoff `setTimeout` at that exact moment, waking up to a bare truthiness
 * check would wrongly see the NEW object and keep running - two concurrent
 * streams for one scope. Comparing against the captured `mine` catches that:
 * once `opts.getShared() !== mine`, this generation exits for good,
 * regardless of what (if anything) replaced it.
 */
export async function runConnectionLoop(
  opts: ConnectionLoopOptions,
  mine: SharedConnection,
): Promise<void> {
  let attempt = 0;
  let consecutiveReauths = 0;

  while (opts.getShared() === mine) {
    const controller = mine.abortController;

    try {
      const outcome = await connectOnce(opts, controller, mine);
      if (opts.getShared() !== mine) return;
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
      if (opts.getShared() !== mine) return;
      void error; // fall through to reconnect below
    }

    if (opts.getShared() !== mine) return;

    opts.onStateChange('reconnecting');
    const delayMs = fullJitterDelay(attempt, opts.random);
    opts.onReconnectScheduled(delayMs);
    attempt += 1;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });

    if (opts.getShared() !== mine) return;
  }
}
