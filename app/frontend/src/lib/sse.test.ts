import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { instanceKeys } from '../features/instances/keys.js';
import { dashboardKeys } from '../features/dashboard/keys.js';
import { jobKeys } from '../features/jobs/keys.js';
import { broadcastKeys } from '../features/broadcasts/keys.js';

/**
 * lib/sse.test.ts (P05 U5 / P15 U6) - proves the SSE client's static
 * event -> query-key invalidation map, `Last-Event-ID` resume, backoff,
 * shared refresh-then-reconnect on 401, resync/batch invalidation, and the
 * ref-counted singleton. Every test builds its own `ReadableStream`-backed
 * `fetch` mock so the real streaming parser is exercised end to end.
 */

function sseStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

function frame(id: string, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('lib/sse.ts', () => {
  let sse: typeof import('./sse.js');
  let setAccessToken: typeof import('./api-client.js').setAccessToken;

  beforeEach(async () => {
    vi.resetModules();
    // `vi.resetModules()` clears the module registry, so `sse.ts`'s own
    // `./api-client.js` import (module state: the in-memory access token)
    // must be re-imported from the SAME fresh registry, never the
    // statically-imported top-of-file instance - otherwise this test file's
    // `setAccessToken` calls would mutate a different module instance than
    // the one `sse.ts` reads `getAccessToken()` from.
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

  it('a_health_changed_event_invalidates_only_that_instances_query_key', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const stream = sseStreamFromChunks([
      frame('1', 'instance.health_changed', {
        type: 'instance.health_changed',
        instanceId,
        healthState: 'green',
        pauseReason: null,
        needsUserAction: false,
      }),
    ]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const handle = sse.acquireRealtimeConnection({ queryClient });
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalled();
    });

    const calledKeys = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey: unknown }).queryKey,
    );
    expect(calledKeys).toContainEqual(instanceKeys.detail(instanceId));
    expect(calledKeys).toContainEqual(instanceKeys.card(instanceId));
    expect(calledKeys).toContainEqual(dashboardKeys.summary());
    expect(calledKeys).toHaveLength(3);

    handle.release();
  });

  it('a_reconnect_resumes_with_the_last_event_id', async () => {
    const stream = sseStreamFromChunks([
      frame('evt-1', 'instance.qr', {
        type: 'instance.qr',
        instanceId: '11111111-1111-4111-8111-111111111111',
        expiresAt: new Date().toISOString(),
        attemptsLeft: 3,
      }),
      frame('evt-2', 'instance.qr', {
        type: 'instance.qr',
        instanceId: '11111111-1111-4111-8111-111111111111',
        expiresAt: new Date().toISOString(),
        attemptsLeft: 2,
      }),
    ]);

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(stream, { status: 200 }));
    // Second call (the reconnect) never resolves in this test - we only
    // assert the request that was made.
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const handle = sse.acquireRealtimeConnection({
      queryClient,
      random: () => 0,
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const secondCallInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const headers = secondCallInit.headers as Record<string, string>;
    expect(headers['Last-Event-ID']).toBe('evt-2');

    handle.release();
  });

  it('backoff delays stay within [0, min(cap, base * 2^n)] and never exceed 30s', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const fetchMock = vi.fn(() => {
      callCount += 1;
      // Every attempt fails immediately (empty, immediately-closed stream),
      // forcing a reconnect with backoff each time.
      return Promise.resolve(new Response(sseStreamFromChunks([]), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const delays: number[] = [];
    const handle = sse.acquireRealtimeConnection({
      queryClient,
      random: () => 1, // worst case: max delay every time
      onReconnectScheduled: (delayMs) => delays.push(delayMs),
    });

    // Drive several reconnect cycles.
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    expect(callCount).toBeGreaterThan(1);
    expect(delays.length).toBeGreaterThan(0);
    delays.forEach((delay, index) => {
      const cap = 30_000;
      const base = 500;
      const expectedCeiling = Math.min(cap, base * 2 ** index);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(expectedCeiling);
      expect(delay).toBeLessThanOrEqual(cap);
    });

    handle.release();
  });

  it('a_resync_frame_invalidates_everything', async () => {
    const stream = sseStreamFromChunks(['id: 0\nevent: resync\ndata: {}\n\n']);
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const handle = sse.acquireRealtimeConnection({ queryClient });

    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith();
    });

    handle.release();
  });

  it('a_401_triggers_one_shared_refresh_then_reconnects', async () => {
    let ensureSessionCalls = 0;
    const ensureSession = vi.fn(async () => {
      ensureSessionCalls += 1;
      setAccessToken('refreshed-token');
      return true;
    });

    const neverClosingStream = new ReadableStream<Uint8Array>({
      // Never calls controller.close()/enqueue() - simulates a live,
      // still-open connection so no third fetch call happens in this test.
      pull: () => undefined,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(neverClosingStream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const handle = sse.acquireRealtimeConnection({
      queryClient,
      ensureSession,
      random: () => 0,
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(ensureSessionCalls).toBe(1);

    const secondCallInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const headers = secondCallInit.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer refreshed-token');

    handle.release();
  });

  it('two_mounts_share_one_connection', async () => {
    const stream = sseStreamFromChunks([]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const first = sse.acquireRealtimeConnection({ queryClient });
    const second = sse.acquireRealtimeConnection({ queryClient });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    first.release();
    // Still one live consumer - fetch should not be called again and the
    // underlying stream must not be aborted yet.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    second.release();

    // Give the abort a microtask/macrotask to propagate.
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: expect.anything() });
    });
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it('unused key factories stay quiet (jobs/broadcasts imported for map coverage only)', () => {
    expect(jobKeys.needsAction()).toEqual(['jobs', 'needsAction']);
    expect(broadcastKeys.detail('c1')).toEqual(['broadcasts', 'detail', 'c1']);
  });
});
