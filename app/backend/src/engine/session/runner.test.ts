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
 * runner.test.ts (P08 U5a) - the runner's `start()` flow driven end-to-end
 * against a FAKE socket (see runner-test-support.ts for the shared fixture
 * machinery). Reconnect-scheduling cases live in their own file
 * (runner-reconnect.test.ts) purely to keep both suites under max-lines.
 */

afterAll(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('createSessionRunner.start (fake socket)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('successful_open_persists_creds_and_sets_linked_connected', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    sock.user = { id: '15550001234:1@s.whatsapp.net' };
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

    await sock.ev.emit('connection.update', { qr: 'fake-qr-string' });
    await sock.ev.emit('connection.update', { connection: 'open' });

    expect(authStore.saveCreds).toHaveBeenCalledTimes(1);

    const row = await pool.query<{
      link_state: string;
      health_state: string;
      needs_user_action: boolean;
      last_connected_at: Date | null;
    }>(
      'SELECT link_state, health_state, needs_user_action, last_connected_at FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(row.rows[0]?.link_state).toBe('linked');
    expect(row.rows[0]?.health_state).toBe('connected');
    expect(row.rows[0]?.needs_user_action).toBe(false);
    expect(row.rows[0]?.last_connected_at).not.toBeNull();

    const qrPublishes = publish.mock.calls.filter((call) => call[0].type === 'instance.qr');
    const healthPublishes = publish.mock.calls.filter(
      (call) => call[0].type === 'instance.health_changed',
    );
    expect(qrPublishes).toHaveLength(1);
    expect(healthPublishes).toHaveLength(1);
  });

  it('sixth_qr_attempt_terminates_with_pairing_expired_and_no_auto_loop', async () => {
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

    await runner.start({ instanceId, clientId, method: 'qr' });

    for (let i = 0; i < 6; i += 1) {
      await sock.ev.emit('connection.update', { qr: `qr-${String(i)}` });
    }

    expect(sock.end).toHaveBeenCalledTimes(1);

    const row = await pool.query<{
      link_state: string;
      health_state: string;
      user_action_reason: string | null;
    }>(
      'SELECT link_state, health_state, user_action_reason FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(row.rows[0]?.link_state).toBe('unlinked');
    // health_state is deliberately left untouched by instance-mark-pairing-
    // expired.sql (see its own header comment) - a never-linked instance
    // stays 'never_linked', not 'paused'.
    expect(row.rows[0]?.health_state).toBe('never_linked');
    expect(row.rows[0]?.user_action_reason).toBe('PAIRING_EXPIRED');

    const leaseRow = await pool.query<{ released_at: Date | null }>(
      'SELECT released_at FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(leaseRow.rows[0]?.released_at).not.toBeNull();

    const qrPublishes = publish.mock.calls.filter((call) => call[0].type === 'instance.qr');
    expect(qrPublishes).toHaveLength(5);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('wires_messages_upsert_to_onMessagesUpsert_when_supplied', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const onMessagesUpsert = vi.fn();

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      onMessagesUpsert,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });

    const payload = { messages: [{ key: { fromMe: true, id: 'wamid-1' } }], type: 'notify' };
    await sock.ev.emit('messages.upsert', payload);

    expect(onMessagesUpsert).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it('never_registers_a_messages_upsert_listener_when_onMessagesUpsert_is_absent', async () => {
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

    await runner.start({ instanceId, clientId, method: 'qr' });

    await expect(sock.ev.emit('messages.upsert', { messages: [], type: 'notify' })).rejects.toThrow(
      /no handler registered/,
    );
  });
});
