import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindInboundMetrics } from './metrics.js';
import { bindInboundBucketCommand } from './admission.js';
import { createInboundDispatcher, type InboundDispatcherDeps } from './handler.js';

/**
 * admission-slow-c2.test.ts (P21 C2 hardening) - "what happens if the
 * dependency is SLOW rather than down" for the admission bucket's own hard
 * timeout (`bindInboundBucketCommand`, default 500ms), and huge-input shape
 * for the dispatcher's `messages.upsert` fan-out. Fake timers throughout -
 * no real waiting, no timing-margin assertions (only the exact fail-open
 * outcome and exact counts are asserted).
 */

interface FakeRedisCommandClient {
  wpInboundAdmit?: (...args: (string | number)[]) => Promise<number>;
  defineCommand: (name: string, opts: unknown) => void;
}

function makeSlowRedisClient(
  resolveAfterMs: number,
  resolvedValue: number,
): FakeRedisCommandClient {
  const client: FakeRedisCommandClient = {
    defineCommand(name: string) {
      if (name !== 'wpInboundAdmit') return;
      client.wpInboundAdmit = () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(resolvedValue), resolveAfterMs);
        });
    },
  };
  return client;
}

describe('bindInboundBucketCommand timeout (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a_bucket_take_that_resolves_after_5s_times_out_at_the_default_500ms_and_rejects', async () => {
    const client = makeSlowRedisClient(5_000, 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const port = bindInboundBucketCommand(client as any, { timeoutMs: 500 });

    const takePromise = port.take('k', 10, 10, 0, 120_000);
    const assertion = expect(takePromise).rejects.toThrow(
      'inbound admission bucket take timed out after 500ms',
    );
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('the_admission_layer_treats_a_bucket_timeout_as_fail_open_admitted_and_counts_it_exactly_once', async () => {
    const client = makeSlowRedisClient(5_000, 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bucket = bindInboundBucketCommand(client as any, { timeoutMs: 500 });
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    // Reimplements createInboundAdmission's own catch branch inline against
    // the REAL bucket port (not a fake bucket) so the fake-timer-driven
    // timeout is the thing under test, not a stand-in.
    const { createInboundAdmission } = await import('./admission.js');
    const admission = createInboundAdmission({
      env: 'test',
      bucket,
      readLimit: async () => 10,
      defaults: { maxPerMinute: 10, burst: 10 },
      clock: () => 0,
      metrics,
    });

    const decisionPromise = admission.admit('client-1', 'instance-1');
    await vi.advanceTimersByTimeAsync(500);
    const decision = await decisionPromise;

    expect(decision).toBe('admitted');
    expect((await metrics.inboundAdmissionFailOpenTotal.get()).values[0]?.value).toBe(1);
    expect((await metrics.inboundShedTotal.get()).values[0]?.value ?? 0).toBe(0);
  });
});

const EMPTY_GROUP_JIDS: ReadonlySet<string> = new Set();

function makeDispatcherDeps(): InboundDispatcherDeps {
  const registry = createMetricsRegistry();
  const metrics = bindInboundMetrics(registry);
  return {
    clientId: 'client-1',
    instanceId: 'instance-1',
    admission: { admit: async () => 'admitted' },
    sendEnabledGroupJids: () => EMPTY_GROUP_JIDS,
    echo: async () => {},
    signals: async () => ({}),
    receipt: async () => ({}),
    deadLetter: async () => ({}),
    metrics,
    logger: { warn: () => {} },
  };
}

function makeUpsertMessage(i: number): unknown {
  return {
    key: { fromMe: false, id: `wamid-${String(i)}`, remoteJid: `${String(i)}@s.whatsapp.net` },
    message: { conversation: 'hi' },
  };
}

describe('huge-input shape: 1000 messages in one messages.upsert payload', () => {
  it('a_thousand_message_upsert_payload_calls_signals_exactly_1000_times_and_writes_no_dead_letter', async () => {
    const signals = vi.fn(async () => ({}));
    const deps = { ...makeDispatcherDeps(), signals };
    const dispatcher = createInboundDispatcher(deps);

    const messages = Array.from({ length: 1000 }, (_, i) => makeUpsertMessage(i));
    await dispatcher.onMessagesUpsert({ messages });

    expect(signals).toHaveBeenCalledTimes(1000);
    expect(
      (await deps.metrics.inboundEventsTotal.get()).values.find((v) => v.labels.kind === 'message')
        ?.value,
    ).toBe(1000);
    expect((await deps.metrics.inboundDeadLettersTotal.get()).values).toHaveLength(0);
  });

  it('a_thousand_message_upsert_payload_with_every_10th_entry_null_dead_letters_zero_times_and_processes_exactly_900', async () => {
    const signals = vi.fn(async () => ({}));
    const deps = { ...makeDispatcherDeps(), signals };
    const dispatcher = createInboundDispatcher(deps);

    const messages = Array.from({ length: 1000 }, (_, i) =>
      i % 10 === 0 ? null : makeUpsertMessage(i),
    );
    await dispatcher.onMessagesUpsert({ messages });

    expect(signals).toHaveBeenCalledTimes(900);
    expect(
      (await deps.metrics.inboundEventsTotal.get()).values.find((v) => v.labels.kind === 'ignored')
        ?.value,
    ).toBe(100);
    expect((await deps.metrics.inboundDeadLettersTotal.get()).values).toHaveLength(0);
  });
});
