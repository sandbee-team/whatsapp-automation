import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupProbeClients } from '../../modules/instances/__tests__/instances-test-helpers.js';
import {
  makeClock,
  makeFakeSock,
  makeFakeTimerScheduler,
  pool,
  probeClientIds,
  seedProbe,
  buildRunner,
  type PublishMock,
} from './runner-test-support.js';

/**
 * runner-send-socket.test.ts (P12 U0) - proves `RunnerHandle.getSendSocket`
 * stays `undefined` until the connection actually opens, hands back a
 * send-only port (never the raw socket, never `.logout()`) once open, and
 * reverts to `undefined` again after teardown. Companion to runner.test.ts;
 * split into its own file so it stays a small, single-purpose suite.
 */

afterAll(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('RunnerHandle.getSendSocket', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('get_send_socket_returns_undefined_before_the_connection_opens', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
    });
    instanceIdHolderSet(instanceId);

    const handle = await runner.start({ instanceId, clientId, method: 'qr' });
    expect(handle).not.toBe('not_acquired');
    if (handle === 'not_acquired') return;

    expect(handle.getSendSocket?.()).toBeUndefined();
  });

  it('get_send_socket_returns_a_send_capable_port_once_the_connection_is_open', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    sock.user = { id: '15550001234:1@s.whatsapp.net' };
    const sendMessage = vi.fn().mockResolvedValue({ id: 'wamid-1' });
    (sock as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const authStore = {
      loadCreds: vi.fn().mockResolvedValue(null),
      saveCreds: vi.fn().mockResolvedValue({ credVersion: 1n }),
    };

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      authStore,
    });
    instanceIdHolderSet(instanceId);

    const handle = await runner.start({ instanceId, clientId, method: 'qr' });
    expect(handle).not.toBe('not_acquired');
    if (handle === 'not_acquired') return;

    await sock.ev.emit('connection.update', { connection: 'open' });

    const sendSocket = handle.getSendSocket?.();
    expect(sendSocket).not.toBeUndefined();
    await sendSocket?.sendMessage('15550009999@s.whatsapp.net', { text: 'hi' });
    expect(sendMessage).toHaveBeenCalledWith('15550009999@s.whatsapp.net', { text: 'hi' });
  });

  it('get_send_socket_returns_undefined_after_teardown', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    sock.user = { id: '15550001234:1@s.whatsapp.net' };
    const sendMessage = vi.fn().mockResolvedValue({ id: 'wamid-1' });
    (sock as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const authStore = {
      loadCreds: vi.fn().mockResolvedValue(null),
      saveCreds: vi.fn().mockResolvedValue({ credVersion: 1n }),
    };

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      authStore,
    });
    instanceIdHolderSet(instanceId);

    const handle = await runner.start({ instanceId, clientId, method: 'qr' });
    expect(handle).not.toBe('not_acquired');
    if (handle === 'not_acquired') return;

    await sock.ev.emit('connection.update', { connection: 'open' });
    expect(handle.getSendSocket?.()).not.toBeUndefined();

    await handle.teardownNoRelease();

    expect(handle.getSendSocket?.()).toBeUndefined();
  });

  it('get_send_socket_never_exposes_logout_or_the_raw_socket', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    sock.user = { id: '15550001234:1@s.whatsapp.net' };
    const sendMessage = vi.fn().mockResolvedValue({ id: 'wamid-1' });
    (sock as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const authStore = {
      loadCreds: vi.fn().mockResolvedValue(null),
      saveCreds: vi.fn().mockResolvedValue({ credVersion: 1n }),
    };

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      authStore,
    });
    instanceIdHolderSet(instanceId);

    const handle = await runner.start({ instanceId, clientId, method: 'qr' });
    expect(handle).not.toBe('not_acquired');
    if (handle === 'not_acquired') return;

    await sock.ev.emit('connection.update', { connection: 'open' });

    const sendSocket = handle.getSendSocket?.();
    expect(sendSocket).not.toBeUndefined();
    expect(sendSocket).not.toBe(sock);
    expect((sendSocket as unknown as { logout?: unknown }).logout).toBeUndefined();
  });
});
