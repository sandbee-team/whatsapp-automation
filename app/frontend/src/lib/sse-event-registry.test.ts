import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

/**
 * lib/sse-event-registry.test.ts (P08 U7) - proves `subscribeRealtimeEvent`,
 * the typed per-event-type listener registry additive to the static
 * invalidation map: delivery to the right type only, unsubscribe actually
 * stops delivery, and unknown event types never reach any subscriber (they
 * are dropped upstream by `isKnownRealtimeEventType`, same as the
 * invalidation map).
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

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

describe('lib/sse.ts - subscribeRealtimeEvent registry', () => {
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

  it('delivers_events_of_the_subscribed_type_to_the_callback', async () => {
    const stream = sseStreamFromChunks([
      frame('1', 'instance.qr', {
        type: 'instance.qr',
        instanceId: INSTANCE_ID,
        expiresAt: new Date().toISOString(),
        attemptsLeft: 3,
        payload: 'qr-payload-string',
      }),
    ]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const received: unknown[] = [];
    const unsubscribe = sse.subscribeRealtimeEvent('instance.qr', (event) => {
      received.push(event);
    });

    const handle = sse.acquireRealtimeConnection({ queryClient });

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toMatchObject({
      type: 'instance.qr',
      instanceId: INSTANCE_ID,
      attemptsLeft: 3,
      payload: 'qr-payload-string',
    });

    unsubscribe();
    handle.release();
  });

  it('unsubscribe_stops_further_delivery', async () => {
    const stream = sseStreamFromChunks([
      frame('1', 'instance.qr', {
        type: 'instance.qr',
        instanceId: INSTANCE_ID,
        expiresAt: new Date().toISOString(),
        attemptsLeft: 3,
        payload: 'first',
      }),
      frame('2', 'instance.qr', {
        type: 'instance.qr',
        instanceId: INSTANCE_ID,
        expiresAt: new Date().toISOString(),
        attemptsLeft: 2,
        payload: 'second',
      }),
    ]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const received: unknown[] = [];
    const unsubscribe = sse.subscribeRealtimeEvent('instance.qr', (event) => {
      received.push(event);
      // Unsubscribe as soon as the first event arrives - the second frame in
      // this same stream must never reach this callback.
      unsubscribe();
    });

    const handle = sse.acquireRealtimeConnection({ queryClient });

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    // Give any (incorrect) further delivery a chance to happen.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(1);

    handle.release();
  });

  it('unknown_event_types_are_never_delivered_to_any_subscriber', async () => {
    const stream = sseStreamFromChunks([
      'id: 1\nevent: some.unknown.type\ndata: {"type":"some.unknown.type"}\n\n',
    ]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const received: unknown[] = [];
    // Subscribes to a REAL type ('instance.qr') even though the stream only
    // ever emits an unknown type - `isKnownRealtimeEventType` drops the
    // unknown frame upstream of this registry entirely, so nothing should
    // ever reach any subscriber, of any type.
    const unsubscribe = sse.subscribeRealtimeEvent('instance.qr', (event) => {
      received.push(event);
    });

    const handle = sse.acquireRealtimeConnection({ queryClient });

    // Let the stream fully drain.
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(0);

    unsubscribe();
    handle.release();
  });

  it('a_second_subscriber_of_a_different_type_does_not_receive_the_first_types_events', async () => {
    const stream = sseStreamFromChunks([
      frame('1', 'instance.qr', {
        type: 'instance.qr',
        instanceId: INSTANCE_ID,
        expiresAt: new Date().toISOString(),
        attemptsLeft: 3,
        payload: 'qr-payload',
      }),
    ]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const qrReceived: unknown[] = [];
    const healthReceived: unknown[] = [];
    const unsubQr = sse.subscribeRealtimeEvent('instance.qr', (event) => {
      qrReceived.push(event);
    });
    const unsubHealth = sse.subscribeRealtimeEvent('instance.health_changed', (event) => {
      healthReceived.push(event);
    });

    const handle = sse.acquireRealtimeConnection({ queryClient });

    await vi.waitFor(() => {
      expect(qrReceived).toHaveLength(1);
    });
    expect(healthReceived).toHaveLength(0);

    unsubQr();
    unsubHealth();
    handle.release();
  });
});
