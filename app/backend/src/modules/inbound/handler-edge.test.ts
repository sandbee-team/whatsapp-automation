import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindInboundMetrics } from './metrics.js';
import { createInboundDispatcher, type InboundDispatcherDeps } from './handler.js';

/**
 * handler-edge.test.ts (P21 E3 hardening) - malformed payloads, adversarial
 * message shapes, concurrency, and port-failure edge cases for
 * `createInboundDispatcher` beyond the sibling `handler.test.ts` and
 * `handler-pii-scan.test.ts`. Every case is deterministic: fakes only, no
 * sleeps, no real network/DB/Redis.
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

describe('createInboundDispatcher - malformed payloads', () => {
  it('a_non_array_null_or_string_messages_upsert_payload_resolves_with_zero_processing', async () => {
    const { deps, echo, signals, deadLetter } = makeDeps();
    const dispatcher = createInboundDispatcher(deps);

    await expect(dispatcher.onMessagesUpsert(null)).resolves.toBeUndefined();
    await expect(dispatcher.onMessagesUpsert(undefined)).resolves.toBeUndefined();
    await expect(dispatcher.onMessagesUpsert('a string payload')).resolves.toBeUndefined();
    await expect(dispatcher.onMessagesUpsert(42)).resolves.toBeUndefined();
    await expect(
      dispatcher.onMessagesUpsert({ messages: 'not-an-array' }),
    ).resolves.toBeUndefined();
    await expect(dispatcher.onMessagesUpsert({})).resolves.toBeUndefined();

    expect(echo).toHaveBeenCalledTimes(0);
    expect(signals).toHaveBeenCalledTimes(0);
    expect(deadLetter).toHaveBeenCalledTimes(0);
  });

  it('a_null_entry_in_messages_upsert_is_ignored_and_counted_never_rejecting_the_dispatcher', async () => {
    // FIXED (was handler.ts:85). `processMessage` used to read `message.key`
    // BEFORE its own `try` block started, so a `null` (or non-object) array
    // entry threw OUTSIDE the try/catch and REJECTED onMessagesUpsert's
    // returned promise - breaking the module's own documented contract
    // ("Each returns a Promise ... NEVER rejects") and the phase invariant
    // "ONE try/catch per event ... never a socket teardown". All per-message
    // field access now happens INSIDE the try; a non-object entry has no key
    // to dead-letter, so it is counted as `kind:'ignored'` and the loop
    // continues to the next (valid) entry.
    const { deps, echo, signals, deadLetter, receipt } = makeDeps();
    const dispatcher = createInboundDispatcher(deps);

    await expect(
      dispatcher.onMessagesUpsert({
        messages: [
          null,
          {},
          { key: null },
          {
            key: {
              id: 'MSG-AFTER-NULL',
              remoteJid: 'a@s.whatsapp.net',
              fromMe: false,
              participant: undefined,
            },
            message: { conversation: 'still processed' },
          },
        ],
      }),
    ).resolves.toBeUndefined();

    expect(echo).toHaveBeenCalledTimes(0);
    expect(deadLetter).toHaveBeenCalledTimes(0);
    expect(receipt).toHaveBeenCalledTimes(0);
    // The valid trailing message IS processed despite the malformed entries
    // ahead of it in the same array.
    expect(signals).toHaveBeenCalledTimes(1);

    const values = (await deps.metrics.inboundEventsTotal.get()).values;
    // null, {} and { key: null } all have no usable key -> 3 'ignored'; the
    // trailing valid message -> 1 'message'.
    expect(values.find((v) => v.labels.kind === 'ignored')?.value).toBe(3);
    expect(values.find((v) => v.labels.kind === 'message')?.value).toBe(1);
  });

  it('a_fromMe_echo_with_a_group_remote_jid_is_never_filtered_and_always_routes_to_echo', async () => {
    const { deps, echo, admit, signals } = makeDeps();
    const dispatcher = createInboundDispatcher(deps);

    const messages = [
      {
        key: {
          id: 'MSG-ECHO-GROUP',
          remoteJid: 'group1@g.us',
          fromMe: true,
          participant: undefined,
        },
        message: { conversation: 'echoed group message' },
      },
    ];
    await dispatcher.onMessagesUpsert({ messages });

    expect(echo).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledTimes(0);
    expect(signals).toHaveBeenCalledTimes(0);
  });

  it('a_participant_with_a_device_suffix_and_a_lid_group_participant_both_become_senderJid_unchanged', async () => {
    const { deps, signals } = makeDeps();
    const dispatcher = createInboundDispatcher(deps);

    const messages = [
      {
        key: {
          id: 'MSG-DEVICE',
          remoteJid: 'group1@g.us',
          fromMe: false,
          participant: '123:4@s.whatsapp.net',
        },
        message: { conversation: 'from a device-suffixed participant' },
      },
    ];
    // group1 is not send-enabled, so this message is filtered by shouldIgnoreJid
    // BEFORE senderJid is ever read - assert it never reaches signals.
    await dispatcher.onMessagesUpsert({ messages });
    expect(signals).toHaveBeenCalledTimes(0);

    // Same participant shape, but a DM remoteJid (never filtered) - senderJid
    // must be the participant verbatim, device suffix intact.
    const dmMessages = [
      {
        key: {
          id: 'MSG-DEVICE-DM',
          remoteJid: 'a@s.whatsapp.net',
          fromMe: false,
          participant: '123:4@s.whatsapp.net',
        },
        message: { conversation: 'hi' },
      },
    ];
    await dispatcher.onMessagesUpsert({ messages: dmMessages });
    expect(signals).toHaveBeenCalledTimes(1);
    expect((signals.mock.calls[0]?.[0] as { senderJid: string }).senderJid).toBe(
      '123:4@s.whatsapp.net',
    );
  });

  it('two_events_processed_via_promise_all_both_complete_with_exact_per_kind_counter_deltas', async () => {
    const { deps } = makeDeps();
    const dispatcher = createInboundDispatcher(deps);

    const upsertPayload = {
      messages: [
        {
          key: {
            id: 'MSG-A',
            remoteJid: 'a@s.whatsapp.net',
            fromMe: false,
            participant: undefined,
          },
          message: { conversation: 'hi a' },
        },
        {
          key: {
            id: 'MSG-B',
            remoteJid: 'b@s.whatsapp.net',
            fromMe: false,
            participant: undefined,
          },
          message: { conversation: 'hi b' },
        },
      ],
    };
    const receiptPayload = [
      {
        key: { fromMe: true, id: 'R-1', remoteJid: 'c@s.whatsapp.net' },
        receipt: { receiptTimestamp: 100 },
      },
      {
        key: { fromMe: true, id: 'R-2', remoteJid: 'd@s.whatsapp.net' },
        receipt: { receiptTimestamp: 200 },
      },
    ];

    await Promise.all([
      dispatcher.onMessagesUpsert(upsertPayload),
      dispatcher.onMessageReceiptUpdate(receiptPayload),
    ]);

    // Never assert interleaving order - only the exact final per-kind counts.
    const values = (await deps.metrics.inboundEventsTotal.get()).values;
    expect(values.find((v) => v.labels.kind === 'message')?.value).toBe(2);
    expect(values.find((v) => v.labels.kind === 'receipt')?.value).toBe(2);
    expect(values.find((v) => v.labels.kind === 'echo')?.value ?? 0).toBe(0);
    expect(values.find((v) => v.labels.kind === 'ignored')?.value ?? 0).toBe(0);
  });

  it('a_deadLetter_port_that_itself_rejects_still_resolves_the_dispatcher_promise', async () => {
    // FIXED. `safeDeadLetter` wraps the `deps.deadLetter` call in its own
    // try/catch: a rejecting port is logged name-only and the loop
    // continues - the dispatcher's own promise must never depend on the
    // dead-letter port honouring its "never throws" contract.
    const signals = vi.fn(async () => {
      throw new Error('signals boom');
    });
    const deadLetter = vi.fn(async () => {
      throw new Error('deadLetter also boom');
    });
    const warn = vi.fn();
    const { deps } = makeDeps({ signals, deadLetter, logger: { warn } });
    const dispatcher = createInboundDispatcher(deps);

    const messages = [
      {
        key: { id: 'MSG-1', remoteJid: 'a@s.whatsapp.net', fromMe: false, participant: undefined },
        message: { conversation: 'hi' },
      },
    ];

    await expect(dispatcher.onMessagesUpsert({ messages })).resolves.toBeUndefined();
    expect(deadLetter).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({ err: 'Error' });
  });

  it('admission_admit_rejecting_is_dead_lettered_and_the_socket_facing_promise_still_resolves', async () => {
    const admit = vi.fn(async () => {
      throw new Error('redis truly gone, not a normal fail-open case');
    });
    const { deps, deadLetter } = makeDeps({ admission: { admit } });
    const dispatcher = createInboundDispatcher(deps);

    const messages = [
      {
        key: { id: 'MSG-1', remoteJid: 'a@s.whatsapp.net', fromMe: false, participant: undefined },
        message: { conversation: 'hi' },
      },
    ];

    // `admission.admit` itself is documented to fail open INSIDE
    // admission.ts (a Redis error there is caught and returns 'admitted').
    // If the PORT PASSED TO THE DISPATCHER throws directly (bypassing that
    // internal fail-open, e.g. a programming error in the composition), the
    // throw happens inside processMessage's try block and IS caught there,
    // producing one dead letter - never a socket teardown. Assert this
    // actual behaviour (the dispatcher's own try/catch wraps the admit call).
    await expect(dispatcher.onMessagesUpsert({ messages })).resolves.toBeUndefined();
    expect(deadLetter).toHaveBeenCalledTimes(1);
    expect(deadLetter).toHaveBeenCalledWith(expect.objectContaining({ waMsgId: 'MSG-1' }));
  });
});
