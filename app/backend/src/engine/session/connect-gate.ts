/**
 * connect-gate.ts (P08 U5a) - `ConnectGate`: an in-process token bucket
 * gating socket (re)connect attempts for ONE worker process. Continuous
 * refill (never a per-second bucket reset), capped at `burst`, queued takers
 * FIFO. P09 swaps a fleet-wide Redis bucket in behind this SAME interface
 * (`ConnectGate`) - callers (the runner) never see the difference.
 */

export interface ConnectGateTakeOptions {
  /** Optional cancellation - see connect-budget.ts's fleet-wide `take()` for the primary consumer (unbounded PROVIDER_OUTAGE-freeze parking, CRITICAL 3 fix). Aborting rejects promptly with a named error; it never resolves. Backward-compatible: every existing caller omits this. */
  signal?: AbortSignal;
}

export interface ConnectGate {
  take(options?: ConnectGateTakeOptions): Promise<void>;
}

/**
 * Default per-worker connect-gate burst size (P09 U6b) - the SAME "5" this
 * module already defaulted `burst` to inline; promoted to a named export so
 * `session-worker-composition.ts`'s wave-vs-single-connect threshold can
 * reference it instead of restating the literal a second time.
 */
export const DEFAULT_PER_WORKER_BURST = 5;

export interface ConnectGateClock {
  now(): number;
}

export interface CreatePerWorkerConnectGateOptions {
  /** Sustained token refill rate, tokens per second. */
  ratePerSec?: number;
  /** Maximum tokens the bucket can hold (an immediate burst this large is never gated). */
  burst?: number;
  clock: ConnectGateClock;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
}

interface QueuedTaker {
  resolve: () => void;
}

/**
 * Continuous-refill token bucket: `tokens` is a real number, topped up by
 * `elapsedMs * ratePerSec / 1000` every time it is touched (take, or the
 * queue-draining timer), capped at `burst`. FIFO queue: a taker who arrives
 * while the bucket is empty waits behind every taker already queued, never
 * jumping ahead of an earlier waiter even if enough tokens accumulate for
 * more than one at once.
 */
export function createPerWorkerConnectGate(
  options: CreatePerWorkerConnectGateOptions,
): ConnectGate {
  const ratePerSec = options.ratePerSec ?? 2;
  const burst = options.burst ?? DEFAULT_PER_WORKER_BURST;
  const { clock, setTimeoutFn } = options;

  let tokens = burst;
  let lastRefillAt = clock.now();
  const queue: QueuedTaker[] = [];
  let drainTimerArmed = false;

  function refill(): void {
    const now = clock.now();
    const elapsedMs = now - lastRefillAt;
    if (elapsedMs <= 0) {
      return;
    }
    lastRefillAt = now;
    tokens = Math.min(burst, tokens + (elapsedMs * ratePerSec) / 1000);
  }

  /** Drains as many queued takers as current tokens allow, then re-arms a timer for the remainder, if any. */
  function drainQueue(): void {
    refill();
    while (queue.length > 0 && tokens >= 1) {
      const next = queue.shift();
      if (!next) break;
      tokens -= 1;
      next.resolve();
    }
    drainTimerArmed = false;
    armDrainTimerIfNeeded();
  }

  function armDrainTimerIfNeeded(): void {
    if (drainTimerArmed || queue.length === 0) {
      return;
    }
    // Tokens needed for the next waiter at the front of the queue - always
    // at least a fraction (< 1) since drainQueue only stops looping once
    // tokens < 1.
    const deficit = Math.max(0, 1 - tokens);
    const waitMs = (deficit * 1000) / ratePerSec;
    drainTimerArmed = true;
    setTimeoutFn(() => {
      drainQueue();
    }, waitMs);
  }

  return {
    async take(): Promise<void> {
      refill();
      if (queue.length === 0 && tokens >= 1) {
        tokens -= 1;
        return;
      }
      return new Promise<void>((resolve) => {
        queue.push({ resolve });
        armDrainTimerIfNeeded();
      });
    },
  };
}
