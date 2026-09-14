import { createDwrrSelector, type DwrrSelector } from '@wp/domain';
import type { QueueMetricsHandles } from './metrics.js';
import type { SendLoopIterationResult } from './send-loop.js';

/**
 * send-loop-fleet-wiring.ts (P11 Unit U5, step 9) - reconciles this
 * worker's `SessionRunnerRegistry` against a live map of running per-
 * instance send loops: start on lease ACQUISITION, stop on lease RELEASE.
 *
 * `registry.ts`'s own doc comment: a `RunnerHandle` exists in the registry
 * ONLY while this process holds that instance's lease - a fresh process
 * restart loses the map entirely, and the lease/fence machinery (never this
 * `Map`) is the source of truth for who owns what. That is exactly why
 * "does the registry currently have an entry for instance X" is the correct
 * acquire/release signal to reconcile against here, rather than inventing a
 * second, parallel lease-event stream: it is derived from the SAME map
 * `roles/session-worker.ts`'s drain wiring already reads (`worker.registry`)
 * for the identical reason.
 *
 * `reconcile()` is called once per discovery-loop tick (`roles/
 * session-worker.ts`'s existing `scheduleNext` timer, right after
 * `runOneScanIteration()`) - NOT a second, independent timer of its own.
 *
 * CONCURRENCY 1 PER INSTANCE: `startOne` wires ONE `trigger()` closure per
 * instance, shared by the wake subscriber's `onWake` and the safety-poll
 * timer's own tick - a simple in-flight flag (`inFlight`) makes an
 * overlapping trigger (a wake landing mid-iteration, or the poll firing
 * before the previous iteration returned) a no-op rather than a second
 * concurrent `runOneIteration` call for the same instance.
 *
 * PER LEASE, PER [R-39]: a fresh `DwrrSelector` is constructed for every
 * newly-started instance (never shared/reused across a release+reacquire)
 * - deficit state is per-worker, in-memory, per LEASED instance, rebuilt on
 * lease acquisition. The fence is read FRESH from `getHeldLease` on every
 * trigger (never cached at start time) so a takeover mid-run is reflected
 * on the very next iteration.
 */

export interface FleetRegistryHandle {
  instanceId: string;
  clientId: string;
  /**
   * Optional (P12 U0) - mirrors `engine/session/registry.ts`'s
   * `RunnerHandle.getSendSocket` structurally, without importing that
   * module's own type here (this file's dependency direction stays one-way:
   * queue engine never imports FROM `engine/session/**`). `send-loop-
   * worker-wiring.ts`'s `bootSendLoopFleetWiring` reads this off
   * `worker.registry` entries to build the production transport's
   * `resolveSendSocket`.
   */
  getSendSocket?(): FleetSendSocketPort | undefined;
}

/** Structural mirror of `BaileysSendSocketPort` (`provider/baileys/adapter.ts`) - see `FleetRegistryHandle.getSendSocket`'s own doc for why this is a copy, not an import. */
export interface FleetSendSocketPort {
  sendMessage(
    jid: string,
    content: Record<string, unknown>,
  ): Promise<{ id?: string | null } | undefined>;
}

export interface StoppablePort {
  stop(): void | Promise<void>;
}

/** Structured logger port, same minimal shape as `EchoCaptureLogger`/`RunnerLogger` - ids-only fields, never payload/recipient data (P14 fix round F3 finding 1). */
export interface SendLoopFleetWiringLogger {
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface SendLoopFleetWiringDeps {
  /** The live registry to reconcile against - `SessionWorker.registry` in production. */
  registry: ReadonlyMap<string, FleetRegistryHandle>;
  /** The CURRENT held lease for `instanceId` - `SessionWorker.getHeldLease` in production; only `fence` is read, fresh, on every trigger. */
  getHeldLease: (instanceId: string) => { fence: bigint } | undefined;
  workerId: string;
  metrics: QueueMetricsHandles;
  /** Structured error sink for a rejected `runOneIteration` call (P14 fix round F3 finding 1) - production wiring binds `@wp/server-kit`'s `logger`. */
  logger: SendLoopFleetWiringLogger;
  /** Runs one send-loop iteration for `(clientId, instanceId)` under the given fence + DWRR selector - production wiring closes over the real `runOneSendLoopIteration` plus `dispatch`/`resolveAck`/`resolveFailure`/`claimOne` deps; this module never imports those directly, keeping it a thin scheduler. */
  runOneIteration: (
    clientId: string,
    instanceId: string,
    fence: bigint,
    dwrr: DwrrSelector,
  ) => Promise<SendLoopIterationResult>;
  /** Starts the wake subscriber for `(clientId, instanceId)`, invoking `onTrigger` on every received wake - the returned port's `stop()` unsubscribes AND is the only thing this module calls on release (no dangling Redis subscription, shutdown-purity discipline). */
  startSubscriber: (
    clientId: string,
    instanceId: string,
    onTrigger: () => void,
  ) => Promise<StoppablePort>;
  /** Starts BOTH the per-instance `next_eligible_at` nudge and the mandatory jittered safety-poll timer for `(clientId, instanceId)`, invoking `onTrigger` on each tick - split into two real `setInterval`s by the caller; this module only needs one combined stop port to tear both down together. */
  startSafetyPollTimer: (
    clientId: string,
    instanceId: string,
    onTrigger: () => void,
  ) => StoppablePort;
}

interface RunningEntry {
  subscriber: StoppablePort;
  timer: StoppablePort;
  dwrr: DwrrSelector;
  inFlight: boolean;
}

export interface SendLoopFleetWiring {
  /** Diffs the registry's current instance set against what is currently running: starts newly-acquired instances, stops newly-released ones. Idempotent - calling it again with no registry change starts/stops nothing. */
  reconcile(): Promise<void>;
  /** Stops every currently-running subscriber/timer - `roles/session-worker.ts`'s drain path calls this once, alongside the heartbeat stop. */
  shutdown(): Promise<void>;
}

export function createSendLoopFleetWiring(deps: SendLoopFleetWiringDeps): SendLoopFleetWiring {
  const running = new Map<string, RunningEntry>();

  function trigger(handle: FleetRegistryHandle, entry: RunningEntry): void {
    if (entry.inFlight) {
      return;
    }
    const lease = deps.getHeldLease(handle.instanceId);
    if (!lease) {
      // The lease was released between the trigger firing and this read -
      // `reconcile()`'s next tick stops this entry; never claim on a fence
      // we can no longer prove we hold (core invariant 2, fail-safe).
      return;
    }
    entry.inFlight = true;
    void deps
      .runOneIteration(handle.clientId, handle.instanceId, lease.fence, entry.dwrr)
      .catch((err: unknown) => {
        // A rejected iteration is a bug in a lower layer, not this
        // scheduler's concern to retry-storm over - the next wake/timer
        // trigger tries again naturally. It must never vanish silently
        // though (P14 fix round F3 finding 1): a mis-configured profile
        // (`GuardPipelineStateInvalidError`) would otherwise strand this
        // instance's whole queue with zero observability. Ids only - never
        // payload/recipient data.
        const reason = err instanceof Error ? err.name : 'UnknownError';
        // `error_class` (not e.g. `err_name`) - the one field name
        // `@wp/server-kit`'s `ALLOWED_LOG_FIELDS` sanitizer actually keeps;
        // any other key would be silently dropped before reaching pino.
        deps.logger.error('send loop iteration failed', {
          client_id: handle.clientId,
          instance_id: handle.instanceId,
          error_class: reason,
        });
        deps.metrics.sendLoopIterationErrorsTotal.inc({ reason });
      })
      .finally(() => {
        entry.inFlight = false;
      });
  }

  async function startOne(handle: FleetRegistryHandle): Promise<void> {
    const entry: RunningEntry = {
      subscriber: { stop: () => undefined },
      timer: { stop: () => undefined },
      dwrr: createDwrrSelector(),
      inFlight: false,
    };
    running.set(handle.instanceId, entry);

    // `wp_wake_received_total` is incremented by `wake.ts`'s own subscriber
    // (its `metrics.incrementWakeReceived` port, bound by the production
    // `startSubscriber` implementation) - NOT re-incremented here, or every
    // received wake would double-count.
    entry.subscriber = await deps.startSubscriber(handle.clientId, handle.instanceId, () => {
      trigger(handle, entry);
    });
    entry.timer = deps.startSafetyPollTimer(handle.clientId, handle.instanceId, () => {
      deps.metrics.safetyPollClaimsTotal.inc();
      trigger(handle, entry);
    });
  }

  async function stopOne(instanceId: string): Promise<void> {
    const entry = running.get(instanceId);
    if (!entry) return;
    running.delete(instanceId);
    await entry.subscriber.stop();
    await entry.timer.stop();
  }

  return {
    async reconcile(): Promise<void> {
      for (const instanceId of [...running.keys()]) {
        if (!deps.registry.has(instanceId)) {
          await stopOne(instanceId);
        }
      }

      for (const handle of deps.registry.values()) {
        if (!running.has(handle.instanceId)) {
          await startOne(handle);
        }
      }
    },

    async shutdown(): Promise<void> {
      for (const instanceId of [...running.keys()]) {
        await stopOne(instanceId);
      }
    },
  };
}

export type { DwrrSelector };
