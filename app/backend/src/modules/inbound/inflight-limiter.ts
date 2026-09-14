import type { InboundMetricsHandles } from './metrics.js';

/**
 * inflight-limiter.ts (P21 C1 fix round, reviewer MAJOR) - ONE bounded
 * in-flight limiter PER WORKER (never per session), guarding the socket
 * handlers in `session-worker-inbound-wiring.ts` from launching an unbounded
 * number of concurrent `withTenant` chains against a fixed-size connection
 * pool. Above `maxInFlight` a task is queued FIFO up to `maxPending`; above
 * both ceilings it is DROPPED - never run, never buffered - and counted on
 * `wp_inbound_overflow_total{kind}` (core invariant 2: this is a fairness/
 * safety valve, not a retry mechanism; a dropped receipt/message is simply
 * lost from this worker's own in-memory queue, exactly as an admission-shed
 * event already is - the durable side, `delivery_events`/`opt_outs`, is only
 * ever written by a task that actually ran).
 */

export type InflightKind = 'message' | 'receipt';

export interface InflightLimiterDeps {
  maxInFlight: number;
  maxPending: number;
  metrics: InboundMetricsHandles;
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
}

export interface InflightLimiter {
  /**
   * Starts `task` now if a slot is free; else queues it FIFO if the pending
   * queue has room; else DROPS it (never runs), increments
   * `wp_inbound_overflow_total{kind}` and warns ids-only (worker-level - no
   * client/instance ids are known here, so none are logged). Never throws; a
   * rejecting task releases its slot and is logged name-only (never
   * `err.message`, which can carry provider payload shape). Returns
   * `'started' | 'queued' | 'dropped'`.
   */
  run(kind: InflightKind, task: () => Promise<void>): 'started' | 'queued' | 'dropped';
  inFlight(): number;
  pending(): number;
}

interface PendingEntry {
  task: () => Promise<void>;
}

export function createInflightLimiter(deps: InflightLimiterDeps): InflightLimiter {
  let inFlightCount = 0;
  const pendingQueue: PendingEntry[] = [];

  function releaseSlot(): void {
    inFlightCount -= 1;
    const next = pendingQueue.shift();
    if (next) {
      runTask(next.task);
    }
  }

  function runTask(task: () => Promise<void>): void {
    inFlightCount += 1;
    let result: Promise<void>;
    try {
      result = task();
    } catch (err) {
      deps.logger.warn(
        { err: err instanceof Error ? err.name : 'unknown' },
        'inbound in-flight limiter: task threw synchronously, slot released',
      );
      releaseSlot();
      return;
    }
    void result
      .catch((err: unknown) => {
        deps.logger.warn(
          { err: err instanceof Error ? err.name : 'unknown' },
          'inbound in-flight limiter: task rejected, slot released',
        );
      })
      .then(() => {
        releaseSlot();
      });
  }

  return {
    run(kind: InflightKind, task: () => Promise<void>): 'started' | 'queued' | 'dropped' {
      if (inFlightCount < deps.maxInFlight) {
        runTask(task);
        return 'started';
      }
      if (pendingQueue.length < deps.maxPending) {
        pendingQueue.push({ task });
        return 'queued';
      }
      deps.metrics.inboundOverflowTotal.inc({ kind });
      deps.logger.warn({ kind }, 'inbound in-flight limiter: overflow, event dropped');
      return 'dropped';
    },
    inFlight(): number {
      return inFlightCount;
    },
    pending(): number {
      return pendingQueue.length;
    },
  };
}
