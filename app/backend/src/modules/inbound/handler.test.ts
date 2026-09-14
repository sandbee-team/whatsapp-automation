import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindInboundMetrics } from './metrics.js';
import { createInboundDispatcher, type InboundDispatcherDeps } from './handler.js';

/**
 * handler.test.ts (P21 Unit U6a, step 7) - proves `createInboundDispatcher`
 * against fakes for every port (admission/echo/signals/receipt/deadLetter) -
 * no real Postgres/Redis/socket. Every case is deterministic. The one big
 * end-to-end PII scan (100 mixed events through the real dispatcher + real
 * `writeInboundDeadLetter`) lives in the sibling `handler-pii-scan.test.ts`
 * (300-line cap split idiom).
 */

const EMPTY_GROUP_JIDS: ReadonlySet<string> = new Set();

type Deps = InboundDispatcherDeps;

function makeDeps(overrides: Partial<Deps> = {}): {
  deps: Deps;
  echo: ReturnType<typeof vi.fn>;
  signals: ReturnType<typeof vi.fn>;
  receipt: ReturnType<typeof vi.fn>;
  deadLetter: ReturnType<typeof vi.fn>;
  admit: ReturnType<typeof vi.fn>;
} {
  const registry = createMetricsRegistry();
  const metrics = bindInboundMetrics(registry);
  const echo = vi.fn(async () => {});
  const signals = vi.fn(async () => ({}));
  const receipt = vi.fn(async () => ({}));
  const deadLetter = vi.fn(async () => ({}));
  const admit = vi.fn(async () => 'admitted' as const);

  const deps: Deps = {
    clientId: 'client-1',
    instanceId: 'instance-1',
    admission: { admit },
    sendEnabledGroupJids: () => EMPTY_GROUP_JIDS,
    echo,
    signals,
    receipt,
    deadLetter,
    metrics,
    logger: { warn: vi.fn() },
    ...overrides,
  };
  return { deps, echo, signals, receipt, deadLetter, admit };
}

function upsertMessage(id: string, remoteJid: string, text: string, fromMe = false) {
  return {
    key: { id, remoteJid, fromMe, participant: undefined },
    message: { conversation: text },
  };
}

describe('createInboundDispatcher', () => {
  it('a_throwing_inbound_handler_writes_a_dead_letter_and_does_not_drop_the_socket', async () => {
    const { deps, signals, deadLetter } = makeDeps();
    signals.mockImplementationOnce(async () => ({}));
    signals.mockImplementationOnce(async () => {
      throw new Error('boom 9876543210');
    });
    signals.mockImplementationOnce(async () => ({}));

    const messages = [
      upsertMessage('MSG-1', 'a@s.whatsapp.net', 'hi'),
      upsertMessage('MSG-2', 'a@s.whatsapp.net', 'hi2'),
      upsertMessage('MSG-3', 'a@s.whatsapp.net', 'hi3'),
    ];

    const dispatcher = createInboundDispatcher(deps);
    await expect(dispatcher.onMessagesUpsert({ messages })).resolves.toBeUndefined();

    expect(signals).toHaveBeenCalledTimes(3);
    expect(deadLetter).toHaveBeenCalledTimes(1);
    expect(deadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ waMsgId: 'MSG-2', errorClass: 'Error' }),
    );
  });

  it('receipts_are_never_shed_and_never_pass_the_group_message_filter', async () => {
    const { deps, receipt, admit } = makeDeps();
    const dispatcher = createInboundDispatcher(deps);

    const messagesUpdate = [
      { key: { fromMe: true, id: 'M-1', remoteJid: 'a@s.whatsapp.net' }, update: { status: 3 } },
      { key: { fromMe: true, id: 'M-2', remoteJid: 'b@s.whatsapp.net' }, update: { status: 4 } },
      { key: { fromMe: true, id: 'M-3', remoteJid: 'group1@g.us' }, update: { status: 3 } },
      { key: { fromMe: true, id: 'M-4', remoteJid: 'status@broadcast' }, update: { status: 3 } },
      { key: { fromMe: true, id: 'M-5', remoteJid: 'c@s.whatsapp.net' }, update: { status: 0 } },
    ];
    const receiptUpdate = [
      {
        key: { fromMe: true, id: 'M-6', remoteJid: 'd@s.whatsapp.net' },
        receipt: { receiptTimestamp: 100 },
      },
      {
        key: { fromMe: true, id: 'M-7', remoteJid: 'e@s.whatsapp.net' },
        receipt: { readTimestamp: 200 },
      },
      {
        key: { fromMe: true, id: 'M-8', remoteJid: 'f@s.whatsapp.net' },
        receipt: { playedTimestamp: 300 },
      },
    ];

    await dispatcher.onMessagesUpdate(messagesUpdate);
    await dispatcher.onMessageReceiptUpdate(receiptUpdate);

    expect(admit).toHaveBeenCalledTimes(0);
    // M-4 (status@broadcast) is ignored; the other 4 messagesUpdate receipts
    // plus all 3 receiptUpdate receipts are recorded: 4 + 3 = 7... but the
    // group one (M-3) must NOT be filtered by the receipt scope either.
    expect(receipt).toHaveBeenCalledTimes(7);
    const recordedIds = receipt.mock.calls.map((call) => (call[0] as { waMsgId: string }).waMsgId);
    expect(recordedIds).not.toContain('M-4');
    expect(recordedIds).toContain('M-3');
  });

  it('shed_messages_are_dropped_before_any_processing', async () => {
    const admit = vi
      .fn()
      .mockResolvedValueOnce('admitted' as const)
      .mockResolvedValueOnce('shed' as const)
      .mockResolvedValueOnce('admitted' as const);
    const { deps, signals } = makeDeps({ admission: { admit } });

    const messages = [
      upsertMessage('MSG-1', 'a@s.whatsapp.net', 'hi-1'),
      upsertMessage('MSG-2', 'b@s.whatsapp.net', 'hi-2'),
      upsertMessage('MSG-3', 'c@s.whatsapp.net', 'hi-3'),
    ];

    const dispatcher = createInboundDispatcher(deps);
    await dispatcher.onMessagesUpsert({ messages });

    expect(signals).toHaveBeenCalledTimes(2);
    const senderJids = signals.mock.calls.map(
      (call) => (call[0] as { senderJid: string }).senderJid,
    );
    expect(senderJids).toEqual(['a@s.whatsapp.net', 'c@s.whatsapp.net']);
  });

  it('echoes_route_to_echo_capture_only_and_skip_admission_and_filter', async () => {
    const { deps, echo, admit, signals } = makeDeps();
    const dispatcher = createInboundDispatcher(deps);

    const messages = [upsertMessage('MSG-1', 'group1@g.us', 'echoed', true)];
    await dispatcher.onMessagesUpsert({ messages });

    expect(echo).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledTimes(0);
    expect(signals).toHaveBeenCalledTimes(0);
  });

  it('newsletter_status_and_unknown_group_messages_are_ignored_and_counted', async () => {
    const { deps, signals } = makeDeps();
    const dispatcher = createInboundDispatcher(deps);

    const messages = [
      upsertMessage('MSG-1', 'status@broadcast', 'x'),
      upsertMessage('MSG-2', 'somechannel@newsletter', 'y'),
      upsertMessage('MSG-3', 'unknown-group@g.us', 'z'),
    ];
    await dispatcher.onMessagesUpsert({ messages });

    expect(signals).toHaveBeenCalledTimes(0);
    expect(
      (await deps.metrics.inboundEventsTotal.get()).values.find((v) => v.labels.kind === 'ignored')
        ?.value,
    ).toBe(3);
  });
});
