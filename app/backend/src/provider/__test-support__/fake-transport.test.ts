import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeTransport } from './fake-transport.js';
import { TransportSendError } from '../provider.types.js';

/**
 * fake-transport.test.ts (P11 Unit U2, step 4) - a small self-test for the
 * fake transport's call-count/latency controls, so later P11 units can
 * trust it without re-deriving its behaviour.
 */

describe('createFakeTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after N ms with the queued provider_msg_id (fake-timer mode)', async () => {
    const transport = createFakeTransport();
    transport.queueResolve(1000, 'wamid-1');

    const promise = transport.send('inst-1', { to: '1@s.whatsapp.net', kind: 'text', text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toEqual({ providerMsgId: 'wamid-1' });
  });

  it('rejects after N ms with the queued SendErrorClass and retryAfterMs', async () => {
    const transport = createFakeTransport();
    transport.queueReject(500, 'rate_limited', 3000);

    const promise = transport.send('inst-1', { to: '1@s.whatsapp.net', kind: 'text', text: 'hi' });
    let caught: unknown;
    const settled = promise.catch((err: unknown) => {
      caught = err;
    });
    await vi.advanceTimersByTimeAsync(500);
    await settled;

    expect(caught).toBeInstanceOf(TransportSendError);
    const sendError = caught as TransportSendError;
    expect(sendError.class).toBe('rate_limited');
    expect(sendError.retryAfterMs).toBe(3000);
  });

  it('a queued "never" outcome never resolves or rejects', async () => {
    const transport = createFakeTransport();
    transport.queueNeverResolves();

    const promise = transport.send('inst-1', { to: '1@s.whatsapp.net', kind: 'text', text: 'hi' });
    let settled = false;
    void promise.then(
      () => (settled = true),
      () => (settled = true),
    );

    await vi.advanceTimersByTimeAsync(100_000);
    expect(settled).toBe(false);
  });

  it('records call count, instanceId and message for every send()', async () => {
    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid-1');
    transport.queueResolve(0, 'wamid-2');

    const msgA = { to: 'a@s.whatsapp.net', kind: 'text' as const, text: 'hello a' };
    const msgB = { to: 'b@s.whatsapp.net', kind: 'text' as const, text: 'hello b' };

    const p1 = transport.send('inst-1', msgA);
    await vi.advanceTimersByTimeAsync(0);
    await p1;
    const p2 = transport.send('inst-2', msgB);
    await vi.advanceTimersByTimeAsync(0);
    await p2;

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]).toEqual({ instanceId: 'inst-1', msg: msgA, callIndex: 0 });
    expect(transport.calls[1]).toEqual({ instanceId: 'inst-2', msg: msgB, callIndex: 1 });
  });

  it('onSend fires synchronously at call time, before the queued outcome settles', async () => {
    const observedCallCounts: number[] = [];
    const transport = createFakeTransport({
      onSend: () => {
        observedCallCounts.push(transport.calls.length);
      },
    });
    transport.queueResolve(1000, 'wamid-1');

    const promise = transport.send('inst-1', { to: '1@s.whatsapp.net', kind: 'text', text: 'hi' });
    // onSend must already have fired, synchronously, even though the
    // outcome has not settled yet (still 1000ms away).
    expect(observedCallCounts).toEqual([1]);

    await vi.advanceTimersByTimeAsync(1000);
    await promise;
  });

  it('isReady defaults to true and is settable per instance, with no network I/O', () => {
    const transport = createFakeTransport();
    expect(transport.isReady('inst-1')).toBe(true);

    transport.setReady('inst-1', false);
    expect(transport.isReady('inst-1')).toBe(false);
    expect(transport.isReady('inst-2')).toBe(true);
  });

  it('a real-latency queued outcome resolves against real wall-clock time', async () => {
    vi.useRealTimers();
    const transport = createFakeTransport();
    transport.queueResolve(10, 'wamid-real', 'real-latency');

    const result = await transport.send('inst-1', {
      to: '1@s.whatsapp.net',
      kind: 'text',
      text: 'hi',
    });
    expect(result).toEqual({ providerMsgId: 'wamid-real' });
  });
});
