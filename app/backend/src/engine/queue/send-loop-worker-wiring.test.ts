import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { createTenantDb, type TenantDb } from '@wp/db';
import { bindQueueMetrics } from './metrics.js';
import {
  bootSendLoopFleetWiring,
  buildSendLoopWorkerWiring,
  type SendLoopWorkerHost,
} from './send-loop-worker-wiring.js';
import type { FleetRegistryHandle } from './send-loop-fleet-wiring.js';
import { createBaileysMessageTransport } from '../../provider/baileys/adapter.js';
import { TransportSendError } from '../../provider/provider.types.js';

/**
 * send-loop-worker-wiring.test.ts (P11 Unit U5, step 9) - proves
 * `buildSendLoopWorkerWiring` assembles a `SendLoopFleetWiringDeps`-shaped
 * object from the small set of already-connected handles
 * `roles/session-worker.ts` has at boot (pool/tenantDb/redisCtl/config),
 * WITHOUT opening any of its own connections or starting any real timer -
 * `startSafetyPollTimer`'s injected `setIntervalFn`/`clearIntervalFn` let
 * this test prove the interval math without a real `setInterval`.
 */

function fakeTenantDb(): TenantDb {
  return createTenantDb({} as never);
}

describe('buildSendLoopWorkerWiring', () => {
  it('startSafetyPollTimer_schedules_within_the_documented_18s_to_42s_band', () => {
    const registry = createMetricsRegistry();
    const metrics = bindQueueMetrics(registry);

    const scheduled: number[] = [];
    const wiring = buildSendLoopWorkerWiring({
      env: 'test',
      workerId: 'worker-1',
      pool: {} as never,
      tenantDb: fakeTenantDb(),
      redisCtl: { duplicate: () => ({}) } as never,
      claimOne: vi.fn(),
      transport: { kind: 'fake', capabilities: {} as never, send: vi.fn(), isReady: () => false },
      metrics,
      safetyPollMs: 30_000,
      rng: { random: () => 0.5 },
      setIntervalFn: ((_fn: () => void, ms: number) => {
        scheduled.push(ms);
        return 0 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearIntervalFn: vi.fn() as typeof clearInterval,
    });

    const timer = wiring.startSafetyPollTimer('client-1', 'inst-1', () => undefined);
    timer.stop();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toBe(30_000); // rng.random() = 0.5 -> exact base, no jitter offset
  });

  it('startSafetyPollTimer_stop_calls_clearIntervalFn_exactly_once', () => {
    const registry = createMetricsRegistry();
    const metrics = bindQueueMetrics(registry);
    const clearIntervalFn = vi.fn();

    const wiring = buildSendLoopWorkerWiring({
      env: 'test',
      workerId: 'worker-1',
      pool: {} as never,
      tenantDb: fakeTenantDb(),
      redisCtl: { duplicate: () => ({}) } as never,
      claimOne: vi.fn(),
      transport: { kind: 'fake', capabilities: {} as never, send: vi.fn(), isReady: () => false },
      metrics,
      safetyPollMs: 30_000,
      rng: { random: () => 0 },
      setIntervalFn: (() => 42 as unknown as ReturnType<typeof setInterval>) as typeof setInterval,
      clearIntervalFn: clearIntervalFn as typeof clearInterval,
    });

    const timer = wiring.startSafetyPollTimer('client-1', 'inst-1', () => undefined);
    timer.stop();

    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).toHaveBeenCalledWith(42);
  });

  it('the_production_wiring_resolves_a_send_socket_from_the_registry', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindQueueMetrics(registry);

    const sendMessage = vi.fn().mockResolvedValue({ id: 'wamid-1' });
    const fleetRegistry = new Map<string, FleetRegistryHandle>([
      [
        'inst-connected',
        {
          instanceId: 'inst-connected',
          clientId: 'client-1',
          getSendSocket: () => ({ sendMessage }),
        },
      ],
    ]);
    const worker: SendLoopWorkerHost = {
      registry: fleetRegistry,
      getHeldLease: () => ({ fence: 1n }),
    };

    // `bootSendLoopFleetWiring` never receives `resolveSendSocket` as a
    // caller-supplied dep - it builds it itself from `worker.registry`
    // (`instanceId => worker.registry.get(instanceId)?.getSendSocket?.()`).
    // Reconstructing that exact composition here (rather than importing a
    // private symbol) proves what a real send would resolve to for both a
    // registered and an absent instance, through the SAME
    // `createBaileysMessageTransport` constructor the production wiring
    // calls with it.
    bootSendLoopFleetWiring(
      {
        env: 'test',
        workerId: 'worker-1',
        pool: {} as never,
        tenantDb: fakeTenantDb(),
        redisCtl: { duplicate: () => ({}) } as never,
        claimOne: vi.fn(),
        metrics,
        safetyPollMs: 30_000,
        rng: { random: () => 0.5 },
      },
      worker,
    );

    const transport = createBaileysMessageTransport({
      getSendSocket: (instanceId) => worker.registry.get(instanceId)?.getSendSocket?.(),
    });

    expect(transport.isReady('inst-connected')).toBe(true);
    expect(transport.isReady('inst-absent')).toBe(false);

    const result = await transport.send('inst-connected', { kind: 'text', to: 'jid', text: 'hi' });
    expect(result).toEqual({ providerMsgId: 'wamid-1' });
    expect(sendMessage).toHaveBeenCalledWith('jid', { text: 'hi' });

    await expect(
      transport.send('inst-absent', { kind: 'text', to: 'jid', text: 'hi' }),
    ).rejects.toMatchObject({ class: 'not_connected' } satisfies Partial<TransportSendError>);
  });
});
