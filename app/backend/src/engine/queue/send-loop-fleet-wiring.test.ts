import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindQueueMetrics } from './metrics.js';
import { createSendLoopFleetWiring } from './send-loop-fleet-wiring.js';

/**
 * send-loop-fleet-wiring.test.ts (P11 Unit U5, step 9) - unit test over
 * `createSendLoopFleetWiring`'s reconcile logic: which per-instance send
 * loops it starts/stops as the session-worker's registry gains/loses
 * `RunnerHandle` entries (a `RunnerHandle` exists in the registry ONLY
 * while this worker holds that instance's lease - `registry.ts`'s own doc
 * comment - so "registry has an entry for X" IS the acquire/release
 * lifecycle signal this wiring reconciles against, without inventing a
 * parallel one). Every collaborator (subscriber factory, timer factory,
 * `runOneSendLoopIteration`) is injected/faked - no real Redis/Postgres,
 * no real timers.
 */

interface FakeHandle {
  instanceId: string;
  clientId: string;
}

function makeRegistry(handles: FakeHandle[]): Map<string, FakeHandle> {
  const registry = new Map<string, FakeHandle>();
  for (const handle of handles) {
    registry.set(handle.instanceId, handle);
  }
  return registry;
}

function makeDeps() {
  const registry_ = makeRegistry([]);
  const metrics = bindQueueMetrics(createMetricsRegistry());

  const startedSubscribers: string[] = [];
  const stoppedSubscribers: string[] = [];
  const timersStarted: string[] = [];
  const timersStopped: string[] = [];
  const wakeTriggers = new Map<string, () => void>();
  const pollTriggers = new Map<string, () => void>();

  return {
    registry: registry_ as unknown as Map<string, { instanceId: string; clientId: string }>,
    getHeldLease: vi.fn().mockReturnValue({ fence: 1n }),
    workerId: 'worker-1',
    metrics,
    logger: { error: vi.fn() },
    runOneIteration: vi.fn().mockResolvedValue({ claimed: false }),
    startSubscriber: vi.fn(async (clientId: string, instanceId: string, onTrigger: () => void) => {
      startedSubscribers.push(`${clientId}:${instanceId}`);
      wakeTriggers.set(instanceId, onTrigger);
      return { stop: async () => stoppedSubscribers.push(`${clientId}:${instanceId}`) };
    }),
    startSafetyPollTimer: vi.fn((clientId: string, instanceId: string, onTrigger: () => void) => {
      timersStarted.push(`${clientId}:${instanceId}`);
      pollTriggers.set(instanceId, onTrigger);
      return { stop: () => timersStopped.push(`${clientId}:${instanceId}`) };
    }),
    __probe: {
      startedSubscribers,
      stoppedSubscribers,
      timersStarted,
      timersStopped,
      wakeTriggers,
      pollTriggers,
    },
  };
}

describe('createSendLoopFleetWiring', () => {
  it('a_newly_registered_instance_starts_exactly_one_subscriber_and_one_safety_poll_timer', async () => {
    const deps = makeDeps();
    const wiring = createSendLoopFleetWiring(deps as never);

    deps.registry.set('inst-1', { instanceId: 'inst-1', clientId: 'client-1' });
    await wiring.reconcile();

    expect(deps.__probe.startedSubscribers).toEqual(['client-1:inst-1']);
    expect(deps.__probe.timersStarted).toEqual(['client-1:inst-1']);
  });

  it('reconciling_again_with_no_registry_change_starts_nothing_twice', async () => {
    const deps = makeDeps();
    const wiring = createSendLoopFleetWiring(deps as never);

    deps.registry.set('inst-1', { instanceId: 'inst-1', clientId: 'client-1' });
    await wiring.reconcile();
    await wiring.reconcile();

    expect(deps.__probe.startedSubscribers).toEqual(['client-1:inst-1']);
    expect(deps.__probe.timersStarted).toEqual(['client-1:inst-1']);
  });

  it('a_released_instance_stops_its_subscriber_and_timer', async () => {
    const deps = makeDeps();
    const wiring = createSendLoopFleetWiring(deps as never);

    deps.registry.set('inst-1', { instanceId: 'inst-1', clientId: 'client-1' });
    await wiring.reconcile();

    deps.registry.delete('inst-1');
    await wiring.reconcile();

    expect(deps.__probe.stoppedSubscribers).toEqual(['client-1:inst-1']);
    expect(deps.__probe.timersStopped).toEqual(['client-1:inst-1']);
  });

  it('shutdown_stops_every_still_running_subscriber_and_timer', async () => {
    const deps = makeDeps();
    const wiring = createSendLoopFleetWiring(deps as never);

    deps.registry.set('inst-1', { instanceId: 'inst-1', clientId: 'client-1' });
    deps.registry.set('inst-2', { instanceId: 'inst-2', clientId: 'client-2' });
    await wiring.reconcile();

    await wiring.shutdown();

    expect(deps.__probe.stoppedSubscribers.sort()).toEqual(['client-1:inst-1', 'client-2:inst-2']);
    expect(deps.__probe.timersStopped.sort()).toEqual(['client-1:inst-1', 'client-2:inst-2']);
  });

  it('a_wake_trigger_runs_exactly_one_iteration_under_the_currently_held_fence', async () => {
    const deps = makeDeps();
    deps.getHeldLease = vi.fn().mockReturnValue({ fence: 7n });
    const wiring = createSendLoopFleetWiring(deps as never);

    deps.registry.set('inst-1', { instanceId: 'inst-1', clientId: 'client-1' });
    await wiring.reconcile();

    deps.__probe.wakeTriggers.get('inst-1')!();
    // runOneIteration is async - flush its microtask queue.
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.runOneIteration).toHaveBeenCalledTimes(1);
    expect(deps.runOneIteration).toHaveBeenCalledWith('client-1', 'inst-1', 7n, expect.anything());
  });

  it('an_overlapping_trigger_while_an_iteration_is_in_flight_is_a_no_op', async () => {
    const deps = makeDeps();
    let resolveIteration!: () => void;
    deps.runOneIteration = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveIteration = () => resolve({ claimed: false });
        }),
    );
    const wiring = createSendLoopFleetWiring(deps as never);

    deps.registry.set('inst-1', { instanceId: 'inst-1', clientId: 'client-1' });
    await wiring.reconcile();

    deps.__probe.wakeTriggers.get('inst-1')!();
    deps.__probe.pollTriggers.get('inst-1')!(); // fires while the first iteration is still in flight
    expect(deps.runOneIteration).toHaveBeenCalledTimes(1);

    resolveIteration();
    await Promise.resolve();
    await Promise.resolve();

    // Once the first iteration settles, a NEW trigger runs a fresh one.
    deps.__probe.wakeTriggers.get('inst-1')!();
    await Promise.resolve();
    expect(deps.runOneIteration).toHaveBeenCalledTimes(2);
  });

  it('a_trigger_after_the_lease_was_released_never_calls_runOneIteration', async () => {
    const deps = makeDeps();
    deps.getHeldLease = vi.fn().mockReturnValue(undefined);
    const wiring = createSendLoopFleetWiring(deps as never);

    deps.registry.set('inst-1', { instanceId: 'inst-1', clientId: 'client-1' });
    await wiring.reconcile();

    deps.__probe.wakeTriggers.get('inst-1')!();
    await Promise.resolve();

    expect(deps.runOneIteration).not.toHaveBeenCalled();
  });

  it('a_rejecting_iteration_logs_ids_only_and_increments_the_iteration_error_counter_by_reason', async () => {
    const deps = makeDeps();
    const err = Object.assign(new Error('bad config'), { name: 'GuardPipelineStateInvalidError' });
    deps.runOneIteration = vi.fn().mockRejectedValue(err);
    const errorLog = vi.fn();
    (deps as unknown as { logger: { error: typeof errorLog } }).logger = { error: errorLog };
    const incSpy = vi.spyOn(deps.metrics.sendLoopIterationErrorsTotal, 'inc');
    const wiring = createSendLoopFleetWiring(deps as never);

    deps.registry.set('inst-1', { instanceId: 'inst-1', clientId: 'client-1' });
    await wiring.reconcile();

    deps.__probe.wakeTriggers.get('inst-1')!();
    await Promise.resolve();
    await Promise.resolve();

    expect(errorLog).toHaveBeenCalledTimes(1);
    const [msg, meta] = errorLog.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toMatch(/send loop iteration/i);
    expect(meta).toEqual({
      client_id: 'client-1',
      instance_id: 'inst-1',
      error_class: 'GuardPipelineStateInvalidError',
    });

    expect(incSpy).toHaveBeenCalledWith({ reason: 'GuardPipelineStateInvalidError' });
  });

  it('a_second_overlapping_trigger_after_the_first_rejects_still_runs_a_fresh_iteration', async () => {
    const deps = makeDeps();
    deps.runOneIteration = vi
      .fn()
      .mockRejectedValueOnce(new Error('first fails'))
      .mockResolvedValueOnce({ claimed: false });
    (deps as unknown as { logger: { error: () => void } }).logger = { error: () => undefined };
    const wiring = createSendLoopFleetWiring(deps as never);

    deps.registry.set('inst-1', { instanceId: 'inst-1', clientId: 'client-1' });
    await wiring.reconcile();

    deps.__probe.wakeTriggers.get('inst-1')!();
    await Promise.resolve();
    await Promise.resolve();

    deps.__probe.wakeTriggers.get('inst-1')!();
    await Promise.resolve();

    expect(deps.runOneIteration).toHaveBeenCalledTimes(2);
  });
});
