import type { Redis } from 'ioredis';
import { describeError, type WpLogger } from '@wp/server-kit';
import { createDiscoveryWakeSubscriber } from '../engine/fleet/discovery-wake.js';

/**
 * session-worker-discovery-wake-wiring.ts (2026-09-17, "QR takes 3-12s to
 * appear" fix) - the discovery scan scheduler (the 5000ms+/-2000ms jittered
 * poll `roles/session-worker.ts` has always run) PLUS the new fleet-wide
 * pub/sub wake that shortens the average wait for the common case, bundled
 * into one `start()`/`stop()` pair. Split into its own file purely so
 * `session-worker.ts` (already close to the 300-line max-lines cap) only
 * gains a few lines - same "boot-wiring lives in a sibling file" idiom
 * `session-worker-discovery-wiring.ts`/`send-loop-worker-wiring.ts` already
 * established for this role. Pure code motion for the scheduler half (the
 * SAME `SCAN_INTERVAL_BASE_MS`/`SCAN_INTERVAL_JITTER_MS`/`scanIntervalMs`
 * this role has always used, moved here unchanged) plus the new wake half.
 *
 * THE POLL IS NEVER CONDITIONAL ON THE WAKE (this fix's own hard
 * requirement): `scheduleNext` below runs on its own unconditional interval
 * regardless of whether any wake ever arrives - `onDiscoveryWake` only
 * cancels the CURRENTLY pending timer and runs the next cycle immediately
 * instead of waiting out the rest of it, exactly the same "pub/sub as a
 * latency optimisation, poll as the correctness backstop" shape
 * `engine/queue/wake.ts` already established for the send loop. A dropped
 * (at-most-once) pub/sub wake is exactly what the poll survives.
 *
 * SINGLE-FLIGHT: `scanInFlight` ensures a wake arriving while a scan is
 * already running never starts a second, overlapping one - it is folded
 * into the run already in progress finishing (and re-arming the timer)
 * sooner than the plain poll would have.
 *
 * The wake SUBSCRIBER's own connection lifecycle (dedicated
 * `redisCtl.duplicate()`, subscribed once at boot, unsubscribed once at
 * shutdown) lives in `engine/fleet/discovery-wake.ts#createDiscoveryWakeSubscriber` -
 * this file only wires its `onWake` callback to the scheduler below.
 */

const SCAN_INTERVAL_BASE_MS = 5000;
const SCAN_INTERVAL_JITTER_MS = 2000;

function scanIntervalMs(random: () => number): number {
  const jitter = (random() * 2 - 1) * SCAN_INTERVAL_JITTER_MS;
  return SCAN_INTERVAL_BASE_MS + jitter;
}

export interface DiscoveryScanSchedulerDeps {
  env: string;
  /** The control-plane Redis handle (`redis-ctl`) - `.duplicate()` is called once here for the wake subscriber's dedicated connection. */
  redisCtl: Pick<Redis, 'duplicate'>;
  worker: { runOneScanIteration(): Promise<void> };
  /** `reconcile()`'s own returned promise is intentionally not awaited here - same as the original inline scheduler this file replaces (pure code motion, `send-loop-fleet-wiring.ts`'s own reconcile tick is independent of this scan cycle's timing). */
  sendLoopWiring: { reconcile(): Promise<void> };
  logger: Pick<WpLogger, 'error'>;
  metrics?: { incrementDiscoveryWakeReceived?: () => void };
  /** Test seams - default to the real `setTimeout`/`clearTimeout`/`Math.random`, same injectable-timer idiom `engine/fleet/discovery.ts#createDiscoveryLoop` already uses. */
  random?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface DiscoveryScanScheduler {
  /** Subscribes the wake channel and starts the scan-interval poll. Call once at boot. */
  start(): Promise<void>;
  /** Unsubscribes, stops the poll, and disconnects the wake subscriber's dedicated connection. Call once during shutdown/drain. */
  stop(): Promise<void>;
}

export function bootDiscoveryScanScheduler(
  deps: DiscoveryScanSchedulerDeps,
): DiscoveryScanScheduler {
  const random = deps.random ?? Math.random;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  let scanInFlight = false;

  function runScanNow(): void {
    if (stopped || scanInFlight) return;
    scanInFlight = true;
    void deps.worker
      .runOneScanIteration()
      .then(() => deps.sendLoopWiring.reconcile())
      .catch((err: unknown) => {
        deps.logger.error({}, `session-worker scan iteration failed: ${describeError(err)}`);
      })
      .finally(() => {
        scanInFlight = false;
        scheduleNext();
      });
  }

  function scheduleNext(): void {
    if (stopped) return;
    timerHandle = setTimeoutFn(runScanNow, scanIntervalMs(random));
  }

  function onDiscoveryWake(): void {
    if (stopped || scanInFlight) return;
    if (timerHandle !== undefined) clearTimeoutFn(timerHandle);
    runScanNow();
  }

  const subscriberRedis = deps.redisCtl.duplicate();
  const subscriber = createDiscoveryWakeSubscriber({
    redis: subscriberRedis,
    env: deps.env,
    onWake: onDiscoveryWake,
    metrics: deps.metrics,
  });

  return {
    async start(): Promise<void> {
      stopped = false;
      await subscriber.start();
      scheduleNext();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timerHandle !== undefined) {
        clearTimeoutFn(timerHandle);
      }
      await subscriber.stop();
      subscriberRedis.disconnect();
    },
  };
}
