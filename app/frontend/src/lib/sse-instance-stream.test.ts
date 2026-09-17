import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

/**
 * lib/sse-instance-stream.test.ts (fix, 2026-09-16 - "QR never reaches the
 * browser" incident) - proves the instance-scoped connection this fix adds:
 * it opens `GET /v1/events?instanceId=<id>` (NOT the bare `/v1/events` the
 * client-wide singleton in `sse.ts` uses), is ref-counted per `instanceId`
 * independently of that client-wide singleton, and never leaks a connection
 * across acquire/release cycles - same idiom as `sse.test.ts` /
 * `sse-strictmode-reacquire.test.ts` (fresh module registry per test via
 * `vi.resetModules()`, a hand-rolled `ReadableStream`-backed `fetch` mock).
 */

describe('lib/sse-instance-stream.ts', () => {
  let instanceStream: typeof import('./sse-instance-stream.js');
  let setAccessToken: typeof import('./api-client.js').setAccessToken;

  beforeEach(async () => {
    vi.resetModules();
    const apiClient = await import('./api-client.js');
    setAccessToken = apiClient.setAccessToken;
    instanceStream = await import('./sse-instance-stream.js');
    setAccessToken('test-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  const instanceId = '11111111-1111-4111-8111-111111111111';

  it('acquiring_an_instance_connection_requests_events_with_the_instanceId_query_param', async () => {
    const stream = new ReadableStream<Uint8Array>({ pull: () => undefined });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const handle = instanceStream.acquireInstanceRealtimeConnection({ instanceId, queryClient });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/v1/events?instanceId=${instanceId}`);

    handle.release();
  });

  it('two_acquires_for_the_same_instanceId_share_one_connection_and_the_second_release_aborts_it', async () => {
    const stream = new ReadableStream<Uint8Array>({ pull: () => undefined });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const first = instanceStream.acquireInstanceRealtimeConnection({ instanceId, queryClient });
    const second = instanceStream.acquireInstanceRealtimeConnection({ instanceId, queryClient });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    first.release();
    // Still one live consumer - the connection must not be aborted yet.
    const signalAfterFirstRelease = (fetchMock.mock.calls[0]?.[1] as RequestInit)
      .signal as AbortSignal;
    expect(signalAfterFirstRelease.aborted).toBe(false);

    second.release();
    await vi.waitFor(() => {
      expect(signalAfterFirstRelease.aborted).toBe(true);
    });
  });

  it('two_different_instanceIds_open_two_independent_connections', async () => {
    const otherInstanceId = '22222222-2222-4222-8222-222222222222';
    const stream1 = new ReadableStream<Uint8Array>({ pull: () => undefined });
    const stream2 = new ReadableStream<Uint8Array>({ pull: () => undefined });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return Promise.resolve(
        new Response(url.includes(otherInstanceId) ? stream2 : stream1, { status: 200 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const a = instanceStream.acquireInstanceRealtimeConnection({ instanceId, queryClient });
    const b = instanceStream.acquireInstanceRealtimeConnection({
      instanceId: otherInstanceId,
      queryClient,
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls).toContain(`/v1/events?instanceId=${instanceId}`);
    expect(urls).toContain(`/v1/events?instanceId=${otherInstanceId}`);

    a.release();
    b.release();
  });

  it('releasing_and_reacquiring_the_same_instanceId_never_leaks_two_concurrent_fetches', async () => {
    // Mirrors sse-strictmode-reacquire.test.ts's exact concern applied to the
    // instance-scoped stream: the Connect sheet can close and reopen for the
    // SAME instance in one React commit (StrictMode, or a fast re-open) -
    // this must behave like a fresh acquire, not two live loops racing.
    const stream = new ReadableStream<Uint8Array>({ pull: () => undefined });
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(stream, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const first = instanceStream.acquireInstanceRealtimeConnection({ instanceId, queryClient });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    first.release();
    const second = instanceStream.acquireInstanceRealtimeConnection({ instanceId, queryClient });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    second.release();
  });

  it('resetInstanceRealtimeConnectionsForTests_aborts_every_open_instance_connection', async () => {
    const stream = new ReadableStream<Uint8Array>({ pull: () => undefined });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    instanceStream.acquireInstanceRealtimeConnection({ instanceId, queryClient });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal as AbortSignal;

    instanceStream.resetInstanceRealtimeConnectionsForTests();
    expect(signal.aborted).toBe(true);
  });
});
