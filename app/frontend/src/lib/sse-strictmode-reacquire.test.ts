import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

/**
 * lib/sse-strictmode-reacquire.test.ts (debugger dispatch, 2026-09-07 -
 * "realtime chip stuck on Reconnecting…" hunt) - proves the EXACT
 * acquire -> release -> acquire sequence React 19 StrictMode performs on
 * every dev-mode mount (AppShell's effect in `components/app-shell.tsx`:
 * mount -> cleanup -> remount, all synchronously within one commit, before
 * the first `fetch()` call has settled).
 *
 * This bug was NOT in `sse.ts`: browser-probe evidence (Playwright against
 * the live dev stack) showed the first (aborted) connection's `net::
 * ERR_ABORTED` is harmless StrictMode noise, and the SECOND connection's
 * `fetch()` call always fires correctly and reaches a 200 response almost
 * immediately once issued - `sse.ts`'s ref-counted singleton and its
 * `shared === mine` identity guards (see `runConnectionLoop`'s own doc
 * comment) already handle this race correctly. The real root cause was
 * `app/frontend/vite.config.ts`'s dev proxy never calling
 * `res.flushHeaders()` on the downstream (browser-facing) response, which
 * left EVERY `/v1/events` connection - proxied or not, StrictMode or not -
 * silently stalled for a full `SSE_HEARTBEAT_MS` (15s default) before the
 * browser's `fetch()` ever saw a response, because the backend correctly
 * flushes its OWN headers immediately but writes no body bytes until the
 * first heartbeat/event.
 *
 * This test stays here as a permanent regression guard for the ACTUAL
 * client-side race this bug report suspected (release-then-reacquire before
 * the first fetch settles): it asserts a second connection attempt starts
 * and the observed connection state reaches `'live'` on a 200 response,
 * something no prior test asserted end to end (the existing
 * `two_mounts_share_one_connection` test in `sse.test.ts` covers two
 * SIMULTANEOUSLY held handles, and `sse-connection-loop.test.ts`'s
 * release-during-backoff-sleep test covers a slower race; neither is this
 * exact synchronous StrictMode timing with a live `onStateChange` assertion).
 */
describe('lib/sse.ts - StrictMode mount -> unmount -> remount before first fetch settles', () => {
  let sse: typeof import('./sse.js');
  let setAccessToken: typeof import('./api-client.js').setAccessToken;

  beforeEach(async () => {
    vi.resetModules();
    const apiClient = await import('./api-client.js');
    setAccessToken = apiClient.setAccessToken;
    sse = await import('./sse.js');
    setAccessToken('test-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('a_release_then_immediate_reacquire_before_the_first_fetch_settles_still_reaches_live', async () => {
    const stream = new ReadableStream<Uint8Array>({ pull: () => undefined });
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(stream, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const states: Array<import('./sse.js').RealtimeConnectionState> = [];

    // mount1 (StrictMode's first pass): fires fetch #1 synchronously.
    const handle1 = sse.acquireRealtimeConnection({
      queryClient,
      onStateChange: (state) => states.push(state),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // cleanup, still synchronous, before fetch #1's promise has settled:
    // aborts fetch #1's signal and nulls the module's `shared` singleton.
    handle1.release();

    // mount2 (StrictMode's remount pass): must start a BRAND NEW connection
    // loop and issue a second fetch call, not silently do nothing because
    // the first loop's generation is still "running" in some stale state.
    const handle2 = sse.acquireRealtimeConnection({
      queryClient,
      onStateChange: (state) => states.push(state),
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // The surviving (second) connection's 200 response must drive the
    // observed state to 'live' - never leaving mount2's listener stuck on
    // its initial 'reconnecting' default forever.
    await vi.waitFor(() => {
      expect(states).toContain('live');
    });

    handle2.release();
  });
});
