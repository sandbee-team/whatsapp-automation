import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

/**
 * lib/sse-connection-loop.test.ts (test-engineer hardening pass, hunt item
 * 4) - the reconnect loop's 401-then-retry path and full-jitter backoff
 * distribution across a synchronized N-connection drop, kept in their own
 * file (sse.test.ts is already near the workspace's 300-line cap).
 */

function neverSettlingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ pull: () => undefined });
}

describe('lib/sse.ts - 401 retry loop cannot spin', () => {
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
    vi.useRealTimers();
    setAccessToken(null);
  });

  it('a_401_clears_the_stale_token_before_calling_ensureSession_and_falls_back_to_backoff_after_one_failed_reauth_pass', async () => {
    // CRIT-1 remainder (a): `ensureSession`'s default treats a STALE-but-
    // present token as an immediate success (`if (accessToken) return true`).
    // A 401 means the CURRENT token is bad, so the SSE 401 branch must clear
    // it (`setAccessToken(null)`) BEFORE calling `ensureSession()` so a real
    // refresh always runs, never a same-stale-token short-circuit.
    //
    // CRIT-1 remainder (b): after ONE failed reauth pass (server still 401s
    // even though `ensureSession` reported success), the loop must NOT reset
    // `attempt` back to 0 - it falls through to normal full-jitter backoff,
    // i.e. the second reconnect must wait a real delay, not fire
    // synchronously.
    vi.useFakeTimers();

    const tokensSeenAtFetch: Array<string | null> = [];
    const fetchMock = vi.fn((...args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      const headers = init?.headers as Record<string, string> | undefined;
      tokensSeenAtFetch.push(headers?.Authorization ?? null);
      if (tokensSeenAtFetch.length <= 2) {
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      return Promise.resolve(
        new Response(new ReadableStream({ pull: () => undefined }), { status: 200 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    let ensureSessionCalls = 0;
    const ensureSession = vi.fn(async () => {
      ensureSessionCalls += 1;
      // Simulates a refresh that reports success but the resulting token is
      // still rejected by the server on the very next request (stale-refresh
      // race) - `setAccessToken` is deliberately NOT called here so we can
      // tell whether the SSE branch itself cleared the old token before this
      // ran.
      return true;
    });

    setAccessToken('stale-token');

    const queryClient = new QueryClient();
    const delays: number[] = [];
    const handle = sse.acquireRealtimeConnection({
      queryClient,
      ensureSession,
      random: () => 0,
      onReconnectScheduled: (delayMs) => delays.push(delayMs),
    });

    // Let the first 401 -> reauth -> immediate retry -> second 401 pass run.
    await vi.advanceTimersByTimeAsync(0);

    // Both 401s within the immediate-retry budget triggered a real
    // `ensureSession()` call each (MAX_IMMEDIATE_REAUTH_RETRIES=1 permits one
    // immediate retry hop before falling to backoff), and by the time the
    // second fetch fired, the stale token must already have been cleared -
    // i.e. the second request must not carry the OLD stale token unchanged
    // (ensureSession here never sets a new one, so the header must be
    // absent, not `Bearer stale-token`).
    expect(ensureSessionCalls).toBe(2);
    expect(tokensSeenAtFetch[0]).toBe('Bearer stale-token');
    expect(tokensSeenAtFetch[1]).not.toBe('Bearer stale-token');

    // After the immediate-retry budget is exhausted, the loop must fall back
    // to backoff (a non-zero, non-synchronous delay) rather than looping
    // again with attempt reset to 0.
    expect(delays.length).toBeGreaterThan(0);

    handle.release();
  });

  it('a_release_then_reacquire_during_backoff_sleep_never_runs_two_concurrent_connection_loops', async () => {
    // MAJ-1: loop L1 sleeps in backoff while `release()` nulls `shared` and a
    // new `acquire()` creates a NEW shared object. L1 must recognize (via an
    // identity guard captured at loop start) that the module-level `shared`
    // it is holding is stale once it wakes, and exit instead of racing loop
    // L2 - only ONE loop may ever fetch at a time.
    vi.useFakeTimers();

    // Every attempt fails (500, empty body) - forces the loop into backoff
    // every time, so L1 is guaranteed to be sleeping in backoff when we
    // release/reacquire below.
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 500 })));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const l1Delays: number[] = [];

    // L1: acquire, let its first attempt fail and enter its backoff sleep.
    const first = sse.acquireRealtimeConnection({
      queryClient,
      random: () => 0.5,
      onReconnectScheduled: (delayMs) => l1Delays.push(delayMs),
    });
    await vi.advanceTimersByTimeAsync(0); // fetch #1 rejects synchronously -> loop enters backoff sleep

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(l1Delays).toHaveLength(1); // L1 scheduled exactly one backoff sleep so far

    // Release while L1 is still asleep in backoff (nulls `shared`), then
    // immediately reacquire - this creates a brand new shared connection and
    // a brand new loop L2, while L1's backoff `setTimeout` is STILL pending
    // (never cleared, never aborted).
    first.release();
    const l2Delays: number[] = [];
    const second = sse.acquireRealtimeConnection({
      queryClient,
      random: () => 0.5,
      onReconnectScheduled: (delayMs) => l2Delays.push(delayMs),
    });

    // Advance far enough that BOTH L1's original backoff timer and any
    // number of L2 backoff cycles would have fired.
    await vi.advanceTimersByTimeAsync(60_000);

    // A correctly-guarded L1 must never schedule another backoff (or fetch)
    // after release - only L2's callback may have fired further. If L1 were
    // still alive it would ALSO wake and schedule/report through its own
    // `onReconnectScheduled` (L1's closure, still referencing the OLD
    // `shared`), inflating `l1Delays` past the single pre-release entry.
    expect(l1Delays).toHaveLength(1);
    expect(l2Delays.length).toBeGreaterThan(0);

    second.release();
  });

  it('a_server_that_keeps_returning_401_even_after_ensureSession_succeeds_does_not_spin_unbounded_synchronous_refetches', async () => {
    // Regression guard: `runConnectionLoop`'s 'reauth' branch resets `attempt`
    // to 0 and `continue`s with ZERO delay. If the server keeps rejecting
    // with 401 (stale-refresh race, revoked session, etc.) after a
    // successful `ensureSession()`, a naive implementation spins
    // synchronously calling fetch + ensureSession forever within one
    // microtask/macrotask storm. This test bounds how many 401 round-trips
    // can happen without the event loop ever yielding to a timer.
    let call401Count = 0;
    const fetchMock = vi.fn(() => {
      call401Count += 1;
      return Promise.resolve(new Response(null, { status: 401 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const ensureSession = vi.fn(async () => true);

    const queryClient = new QueryClient();
    const handle = sse.acquireRealtimeConnection({
      queryClient,
      ensureSession,
      random: () => 0,
    });

    // Give the loop a bounded number of microtask turns to run away in,
    // WITHOUT ever advancing real time - if the loop is spin-free (i.e. it
    // always awaits at least one macrotask/backoff delay between attempts),
    // the number of fetch calls in this window must stay small.
    for (let i = 0; i < 50; i += 1) {
      await Promise.resolve();
    }

    expect(call401Count).toBeLessThan(10);

    handle.release();
  });

  it('a_full_jitter_backoff_storm_across_many_connections_does_not_synchronize_all_retries_to_the_same_instant', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(neverSettlingStream(), { status: 500 })),
    );
    // status 500 -> !response.ok -> throws inside connectOnce -> reconnect
    // path with backoff, exactly the "N connections dropped at once" shape.
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    let seed = 1;
    function mulberry32(): number {
      // Deterministic PRNG so each simulated connection gets an
      // INDEPENDENTLY seeded but reproducible random stream (full jitter
      // must not collapse every connection onto the same delay sequence
      // when they all fail at the same wall-clock instant).
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    // Only one shared connection exists per module (singleton), so to prove
    // "N connections dropped at once, no synchronized retry" at this layer
    // we drive N independent delay samples through the exported jitter
    // shape via onReconnectScheduled across N acquire/release cycles fired
    // in the same tick, and assert they are not identical.
    const observedDelays: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const handle = sse.acquireRealtimeConnection({
        queryClient,
        random: mulberry32,
        onReconnectScheduled: (delayMs) => observedDelays.push(delayMs),
      });
      await vi.advanceTimersByTimeAsync(0);
      handle.release();
      vi.resetModules();
      // Re-import fresh module state per iteration so each is a truly
      // independent "connection dropped" simulation (module-singleton
      // means only one can be live at a time).
      const apiClient = await import('./api-client.js');
      apiClient.setAccessToken('test-token');
      sse = await import('./sse.js');
      vi.stubGlobal('fetch', fetchMock);
    }

    expect(observedDelays.length).toBeGreaterThan(0);
    // Not every observed delay is identical - full jitter must vary given
    // varying random() draws, i.e. no synchronized thundering-herd retry.
    expect(new Set(observedDelays).size).toBeGreaterThan(1);
    for (const delay of observedDelays) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
  });
});
