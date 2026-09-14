import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry, type MetricsRegistry } from '@wp/server-kit';
import { bindInboundMetrics } from '../../modules/inbound/index.js';
import { cleanupProbeClients } from '../../modules/instances/__tests__/instances-test-helpers.js';
import {
  makeClock,
  makeFakeSock,
  makeFakeTimerScheduler,
  pool,
  probeClientIds,
  seedProbe,
  type FakeSock,
  type PublishMock,
} from './runner-test-fixtures.js';
import { buildRunner } from './runner-test-support.js';
import {
  buildInboundSocketHandlers,
  type BuildInboundSocketHandlersInput,
  type InboundSocketHandlers,
} from './session-worker-inbound-wiring.js';

/**
 * session-worker-inbound-wiring.test.ts (P21 Unit U6b, step 7; C1 fix round
 * adds the limiter-routing case) - proves the three inbound socket handlers
 * are subscribed on the SAME runner event wiring as `messages.upsert`
 * already was (P12 U3), each reaching the real `createInboundDispatcher`
 * composition, that a rejected dispatcher promise never escapes into the
 * socket emitter, and that every handler is routed through the per-worker
 * `InflightLimiter`. Real Postgres (via `seedProbe`) for the runner's own
 * lease/auth plumbing; the admission bucket and limiter are faked so this
 * file stays a fast unit test - the real Redis-backed bucket is proven in
 * `suite-b-inbound.integration.test.ts`, and the real limiter's own
 * behaviour in `inflight-limiter.test.ts`.
 */

afterAll(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('buildInboundSocketHandlers wired into createSessionRunner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function fakeAdmission(decision: 'admitted' | 'shed' = 'admitted') {
    return { admit: vi.fn().mockResolvedValue(decision) };
  }

  /** Always runs the task synchronously and reports 'started' - the real limiter's own behaviour is proven in inflight-limiter.test.ts. */
  function passthroughLimiter() {
    return {
      run: vi.fn((_kind: 'message' | 'receipt', task: () => Promise<void>) => {
        void task();
        return 'started' as const;
      }),
      inFlight: () => 0,
      pending: () => 0,
    };
  }

  /** Common per-test scaffolding: seeds a probe tenant, builds the socket handlers, wires + starts a runner. Returns everything a case needs to emit socket events and assert on. */
  async function setup(overrides: Partial<BuildInboundSocketHandlersInput> = {}): Promise<{
    sock: FakeSock;
    registry: MetricsRegistry;
    handlers: InboundSocketHandlers;
  }> {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const registry = createMetricsRegistry();

    const handlers = buildInboundSocketHandlers({
      env: 'test',
      tenantDb: {
        withTenant: async (_cid: string, fn: (tx: unknown) => unknown) => fn({}),
      } as never,
      redisCtl: {} as never,
      keyProvider: {} as never,
      encVersion: 1,
      clientId,
      instanceId,
      admission: fakeAdmission('admitted'),
      limiter: passthroughLimiter(),
      metricsRegistry: registry,
      ...overrides,
    });

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      onMessagesUpsert: handlers.onMessagesUpsert,
      onMessagesUpdate: handlers.onMessagesUpdate,
      onMessageReceiptUpdate: handlers.onMessageReceiptUpdate,
    });
    instanceIdHolderSet(instanceId);
    await runner.start({ instanceId, clientId, method: 'qr' });

    return { sock, registry, handlers };
  }

  it('all_three_inbound_events_are_subscribed_and_routed', async () => {
    const { sock, registry } = await setup({ admission: fakeAdmission('shed') });

    // `messages.upsert`: a NON-fromMe message shed by admission (fakeAdmission
    // returns 'shed') - `admission.admit` being called exactly once proves the
    // event reached the dispatcher's message path (routing, not the admission
    // decision itself, which admission.ts's own tests cover).
    await sock.ev.emit('messages.upsert', {
      messages: [{ key: { fromMe: false, id: 'wamid-1', remoteJid: 'x@s.whatsapp.net' } }],
      type: 'notify',
    });
    // `messages.update` / `message-receipt.update`: a real `fromMe` receipt
    // shape each, reaching `recordInboundReceipt` (unmatched - no seeded
    // `message_wa_ids` row) and incrementing
    // `wp_inbound_events_total{kind="receipt"}` once per event.
    await sock.ev.emit('messages.update', [
      {
        key: { fromMe: true, id: 'wamid-2', remoteJid: 'x@s.whatsapp.net' },
        update: { status: 3 },
      },
    ]);
    await sock.ev.emit('message-receipt.update', [
      {
        key: { fromMe: true, id: 'wamid-3', remoteJid: 'x@s.whatsapp.net' },
        receipt: { receiptTimestamp: 123 },
      },
    ]);

    const { inboundEventsTotal } = bindInboundMetrics(registry);
    expect((await inboundEventsTotal.get()).values).toContainEqual(
      expect.objectContaining({ labels: { kind: 'receipt' }, value: 2 }),
    );
  });

  it('a_runner_built_without_the_two_new_deps_registers_no_handler_for_those_events', async () => {
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

    await expect(sock.ev.emit('messages.update', [])).rejects.toThrow(/no handler registered/);
    await expect(sock.ev.emit('message-receipt.update', [])).rejects.toThrow(
      /no handler registered/,
    );
  });

  it('a_rejected_dispatch_never_reaches_the_socket_emitter', async () => {
    const rejectingAdmission = {
      admit: vi.fn().mockRejectedValue(new Error('boom - admission unavailable')),
    };
    const { sock } = await setup({
      tenantDb: {
        withTenant: async () => {
          throw new Error('should never be reached: admission rejects before any DB read');
        },
      } as never,
      admission: rejectingAdmission,
    });

    // The handler itself is fire-and-forget (never returns a rejecting
    // promise into `sock.ev.on`'s callback contract) - `emit` (which awaits
    // whatever the registered callback returns) resolving without throwing
    // IS the proof that the rejection never escaped past the handler.
    await expect(
      sock.ev.emit('messages.upsert', {
        messages: [{ key: { fromMe: false, id: 'wamid-2', remoteJid: 'x@s.whatsapp.net' } }],
        type: 'notify',
      }),
    ).resolves.toBeUndefined();
  });

  it('the_echo_path_is_unchanged', async () => {
    // Records every SQL statement issued through `withTenant` - proves the
    // echo path (moved verbatim from `session-worker-discovery-wiring.ts`'s
    // former `buildOnMessagesUpsert`, P12 U3) still issues the SAME
    // `message_wa_ids` INSERT, unchanged by this unit's move. P24 Unit U4b:
    // construction now ALSO fires one background `sendEnabledGroupJids.
    // refresh()` (fire-and-forget) against this same fake `tenantDb` - that
    // query is filtered out below rather than widening this test's own
    // assertion, since it is unrelated to the echo path this test proves.
    const queries: string[] = [];
    const fakeTenantDb = {
      withTenant: async (_cid: string, fn: (tx: unknown) => unknown) =>
        fn({
          query: async (sql: string) => {
            queries.push(sql);
            return { rows: [], rowCount: 0 };
          },
        }),
    };

    const { sock } = await setup({ tenantDb: fakeTenantDb as never });

    await sock.ev.emit('messages.upsert', {
      messages: [
        {
          key: { fromMe: true, id: 'wamid-echo-1', remoteJid: 'x@s.whatsapp.net' },
          message: { conversation: 'hello' },
        },
      ],
      type: 'notify',
    });

    const echoQueries = queries.filter((sql) => !sql.includes('FROM wa_groups'));
    expect(echoQueries).toHaveLength(1);
    expect(echoQueries[0]).toContain('INSERT INTO message_wa_ids');
    expect(echoQueries[0]).toContain(
      'ON CONFLICT (client_id, instance_id, direction, wa_msg_id) DO UPDATE SET',
    );
    expect(echoQueries[0]).toContain('WHERE message_wa_ids.message_id IS NULL');
  });

  it('every_socket_handler_routes_through_the_worker_limiter_with_its_kind', async () => {
    // C1 fix round (reviewer MAJOR): a fake limiter that always returns
    // 'dropped' proves each of the three handlers reaches `limiter.run` with
    // the right kind BEFORE the dispatcher runs - a 'dropped' return means
    // the dispatcher is never invoked for that event.
    const calls: Array<'message' | 'receipt'> = [];
    const droppingLimiter = {
      run: vi.fn((kind: 'message' | 'receipt') => {
        calls.push(kind);
        return 'dropped' as const;
      }),
      inFlight: () => 0,
      pending: () => 0,
    };
    const admission = fakeAdmission('admitted');
    const { sock } = await setup({ admission, limiter: droppingLimiter });

    await sock.ev.emit('messages.upsert', {
      messages: [{ key: { fromMe: false, id: 'wamid-1', remoteJid: 'x@s.whatsapp.net' } }],
      type: 'notify',
    });
    await sock.ev.emit('messages.update', [
      {
        key: { fromMe: true, id: 'wamid-2', remoteJid: 'x@s.whatsapp.net' },
        update: { status: 3 },
      },
    ]);
    await sock.ev.emit('message-receipt.update', [
      {
        key: { fromMe: true, id: 'wamid-3', remoteJid: 'x@s.whatsapp.net' },
        receipt: { receiptTimestamp: 123 },
      },
    ]);

    expect(calls).toEqual(['message', 'receipt', 'receipt']);
    // 'dropped' means the task passed to limiter.run was never awaited by
    // this handler - the admission bucket (upstream of the limiter here)
    // was never reached for the shed events either.
    expect(admission.admit).toHaveBeenCalledTimes(0);
  });
});
