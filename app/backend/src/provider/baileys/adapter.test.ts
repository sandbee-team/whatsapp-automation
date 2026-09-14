import { describe, expect, it, vi } from 'vitest';
import { createSessionRegistry } from '../../engine/session/registry.js';
import type { RunnerHandle } from '../../engine/session/registry.js';
import {
  createBaileysChannelLink,
  createBaileysMessageTransport,
  type BaileysSendSocketPort,
} from './adapter.js';
import type { ChannelLinkInstancesPort } from './adapter-types.js';
import { TransportSendError } from '../provider.types.js';

/**
 * adapter.test.ts (P08 Unit U6a; P11 Unit U2 extends this file rather than
 * clobbering it) - `createBaileysChannelLink`'s four methods, all against
 * FAKES (registry + a narrow `instances` port this module declares) - no
 * real WhatsApp anywhere in this file. `unlink` is the
 * ONE legal `sock.logout(` call site in the repo (see
 * `logout-call-sites.test.ts`), so its fake handle exposes `getSock()`
 * returning a `logout` spy - the exact shape `unlink` is allowed to call.
 */

const CLIENT_ID = 'client-1';
const INSTANCE_ID = 'inst-1';

function makeHandle(overrides: Partial<RunnerHandle> = {}): RunnerHandle {
  return {
    instanceId: INSTANCE_ID,
    clientId: CLIENT_ID,
    end: vi.fn(),
    teardownNoRelease: vi.fn().mockResolvedValue(undefined),
    teardownWithRelease: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeInstancesPort(
  overrides: Partial<ChannelLinkInstancesPort> = {},
): ChannelLinkInstancesPort {
  return {
    readSessionEpoch: vi.fn().mockResolvedValue({
      sessionEpoch: 0,
      healthState: 'connected',
      linkState: 'linked',
    }),
    beginPairingIntent: vi.fn().mockResolvedValue(true),
    resetPairingWindow: vi.fn().mockResolvedValue(true),
    runLoggedOutFlow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('createBaileysChannelLink', () => {
  it('unlink_calls_logout_then_purges_and_is_idempotent', async () => {
    const registry = createSessionRegistry();
    const logout = vi.fn().mockResolvedValue(undefined);
    const handle = makeHandle({ getSock: () => ({ logout }) });
    registry.set(INSTANCE_ID, handle);
    const instances = makeInstancesPort();
    const link = createBaileysChannelLink({
      registry,
      instances,
      clock: { now: () => 0 },
    });

    await link.unlink(INSTANCE_ID, 'user_request');

    expect(logout).toHaveBeenCalledTimes(1);
    expect(instances.runLoggedOutFlow).toHaveBeenCalledTimes(1);
    expect(instances.runLoggedOutFlow).toHaveBeenCalledWith(INSTANCE_ID);

    // Second call: registry no longer holds the handle (removed by the
    // caller/runner teardown in real use) - simulate that here so the
    // second unlink call has no socket at all.
    registry.delete(INSTANCE_ID);

    await expect(link.unlink(INSTANCE_ID, 'user_request')).resolves.toBeUndefined();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(instances.runLoggedOutFlow).toHaveBeenCalledTimes(2);
  });

  it('unlink_without_a_live_socket_still_purges', async () => {
    const registry = createSessionRegistry();
    const instances = makeInstancesPort();
    const link = createBaileysChannelLink({
      registry,
      instances,
      clock: { now: () => 0 },
    });

    await link.unlink(INSTANCE_ID, 'deleted');

    expect(instances.runLoggedOutFlow).toHaveBeenCalledTimes(1);
    expect(instances.runLoggedOutFlow).toHaveBeenCalledWith(INSTANCE_ID);
  });

  it('unlink_swallows_a_logout_provider_error_and_still_purges', async () => {
    const registry = createSessionRegistry();
    const logout = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    const handle = makeHandle({ getSock: () => ({ logout }) });
    registry.set(INSTANCE_ID, handle);
    const instances = makeInstancesPort();
    const link = createBaileysChannelLink({
      registry,
      instances,
      clock: { now: () => 0 },
    });

    await expect(link.unlink(INSTANCE_ID, 'user_request')).resolves.toBeUndefined();

    expect(logout).toHaveBeenCalledTimes(1);
    expect(instances.runLoggedOutFlow).toHaveBeenCalledTimes(1);
  });

  it('begin_and_refresh_drive_the_intent_writes', async () => {
    const registry = createSessionRegistry();
    const instances = makeInstancesPort();
    const now = 1_000;
    const link = createBaileysChannelLink({
      registry,
      instances,
      clock: { now: () => now },
    });

    const challenge = await link.beginLink(INSTANCE_ID, { method: 'qr' });

    expect(instances.beginPairingIntent).toHaveBeenCalledWith(INSTANCE_ID);
    expect(challenge).toEqual({
      type: 'qr',
      payload: '',
      expiresAt: new Date(now + 45_000),
      attemptsLeft: 5,
    });

    const refreshed = await link.refreshChallenge(INSTANCE_ID);
    expect(instances.resetPairingWindow).toHaveBeenCalledWith(INSTANCE_ID);
    expect(refreshed).toEqual({
      type: 'qr',
      payload: '',
      expiresAt: new Date(now + 45_000),
      attemptsLeft: 5,
    });

    // Exhausted + unreset window -> null, no retry timer scheduled anywhere.
    const exhaustedInstances = makeInstancesPort({
      resetPairingWindow: vi.fn().mockResolvedValue(false),
    });
    const exhaustedLink = createBaileysChannelLink({
      registry,
      instances: exhaustedInstances,
      clock: { now: () => now },
    });
    const nullResult = await exhaustedLink.refreshChallenge(INSTANCE_ID);
    expect(nullResult).toBeNull();
  });

  it('link_status_maps_the_read', async () => {
    const registry = createSessionRegistry();
    const instances = makeInstancesPort({
      readSessionEpoch: vi.fn().mockResolvedValue({
        sessionEpoch: 3,
        healthState: 'degraded',
        linkState: 'pairing',
      }),
    });
    const link = createBaileysChannelLink({
      registry,
      instances,
      clock: { now: () => 0 },
    });

    const status = await link.linkStatus(INSTANCE_ID);

    expect(instances.readSessionEpoch).toHaveBeenCalledWith(INSTANCE_ID);
    expect(status).toEqual({ linkState: 'pairing', healthState: 'degraded' });
  });
});

/**
 * A socket stub that THROWS/records if any of its methods are touched -
 * used to prove `isReady()` performs no network I/O (P11 U2 step 4).
 */
function makeThrowingSocket(): BaileysSendSocketPort {
  return {
    sendMessage: vi.fn().mockImplementation(() => {
      throw new Error('isReady must never touch the socket');
    }),
  };
}

describe('createBaileysMessageTransport', () => {
  it('capabilities_shape_is_the_canonical_baileys_v1_surface', () => {
    const transport = createBaileysMessageTransport({ getSendSocket: () => undefined });

    expect(transport.kind).toBe('baileys');
    // P34 (ADR 0052 accepted scope): `kinds` now reflects real translations
    // (text/image/document); `maxMediaBytes` is the LARGER of the two media
    // caps (document, 20 MB) - see adapter.ts's own doc comment.
    expect(transport.capabilities).toEqual({
      kinds: ['text', 'image', 'document'],
      groups: true,
      maxMediaBytes: 20 * 1024 * 1024,
      requiresOptIn: false,
    });
  });

  it('a_non_text_kind_throws_instead_of_silently_sending_text', async () => {
    const sendMessage = vi.fn(() => Promise.resolve({ id: 'wamid.HBg=' }));
    const transport = createBaileysMessageTransport({
      getSendSocket: () => ({ sendMessage }) as never,
    });

    await expect(
      transport.send(INSTANCE_ID, {
        to: '911234567890@s.whatsapp.net',
        kind: 'sticker',
        text: 'caption only',
      } as never),
    ).rejects.toThrow(/no wire translation for message kind/);
    // The point of the throw: nothing reached the wire as a text message,
    // so nothing could be billed at the media rate for a text delivery.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('is_ready_performs_no_network_io_and_reflects_local_socket_presence', () => {
    const throwingSocket = makeThrowingSocket();
    const transport = createBaileysMessageTransport({
      getSendSocket: (instanceId) => (instanceId === INSTANCE_ID ? throwingSocket : undefined),
    });

    expect(transport.isReady(INSTANCE_ID)).toBe(true);
    expect(transport.isReady('some-other-instance')).toBe(false);
    // The socket's own sendMessage was declared to throw if touched -
    // isReady() completing without throwing proves it was never called.
    expect(throwingSocket.sendMessage).not.toHaveBeenCalled();
  });

  it('send_happy_path_resolves_with_the_provider_message_id', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ id: 'wamid.HBg=' });
    const transport = createBaileysMessageTransport({
      getSendSocket: () => ({ sendMessage }),
    });

    const outcome = await transport.send(INSTANCE_ID, {
      to: '911234567890@s.whatsapp.net',
      kind: 'text',
      text: 'hello',
    });

    expect(outcome).toEqual({ providerMsgId: 'wamid.HBg=' });
    expect(sendMessage).toHaveBeenCalledWith('911234567890@s.whatsapp.net', { text: 'hello' });
  });

  it('send_rejects_with_not_connected_when_no_socket_is_open', async () => {
    const transport = createBaileysMessageTransport({ getSendSocket: () => undefined });

    await expect(
      transport.send(INSTANCE_ID, { to: '911234567890@s.whatsapp.net', kind: 'text', text: 'hi' }),
    ).rejects.toMatchObject({ class: 'not_connected' });
  });

  it('send_maps_a_boom_style_provider_failure_through_error_map', async () => {
    const sendMessage = vi.fn().mockRejectedValue({ message: 'boom', output: { statusCode: 500 } });
    const transport = createBaileysMessageTransport({ getSendSocket: () => ({ sendMessage }) });

    let caught: unknown;
    try {
      await transport.send(INSTANCE_ID, {
        to: '911234567890@s.whatsapp.net',
        kind: 'text',
        text: 'hi',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TransportSendError);
    expect((caught as TransportSendError).class).toBe('transient');
  });

  it('send_rejects_with_unknown_when_the_provider_returns_no_message_id', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ id: null });
    const transport = createBaileysMessageTransport({ getSendSocket: () => ({ sendMessage }) });

    await expect(
      transport.send(INSTANCE_ID, { to: '911234567890@s.whatsapp.net', kind: 'text', text: 'hi' }),
    ).rejects.toMatchObject({ class: 'unknown' });
  });
});
