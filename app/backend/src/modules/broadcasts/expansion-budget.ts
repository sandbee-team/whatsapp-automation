/**
 * expansion-budget.ts (P23 Unit U4, step 5) - the fleet-wide expansion token
 * bucket (~5,000 rows/s). ONE instance is shared by both the snapshot and
 * expansion cron sweeps for the whole deployment (never per-client, never
 * per-campaign) so one tenant's broadcast cannot stall another tenant's
 * claim latency by monopolising expansion throughput. Refill is computed
 * from the injected `clock`, never `Date.now()` directly, so a test can
 * assert exact token counts at exact simulated instants.
 */
export interface ExpansionBudgetClock {
  now(): number;
}

export interface ExpansionBudgetOptions {
  /** Steady-state refill rate, tokens/second. */
  ratePerSecond: number;
  /** Maximum tokens the bucket can ever hold (also the starting balance). */
  burst: number;
  clock: ExpansionBudgetClock;
}

export interface ExpansionBudget {
  /** Attempts to take `n` tokens; refills from elapsed time since the last take/refill FIRST, then decides. Returns `false` (no tokens consumed) when insufficient. */
  tryTake(n: number): boolean;
}

/** Builds a token bucket seeded at `burst` tokens, refilling at `ratePerSecond`. */
export function createExpansionBudget(options: ExpansionBudgetOptions): ExpansionBudget {
  let tokens = options.burst;
  let lastRefillAtMs = options.clock.now();

  function refill(): void {
    const nowMs = options.clock.now();
    const elapsedMs = nowMs - lastRefillAtMs;
    if (elapsedMs <= 0) {
      return;
    }
    const refilled = (elapsedMs / 1000) * options.ratePerSecond;
    tokens = Math.min(options.burst, tokens + refilled);
    lastRefillAtMs = nowMs;
  }

  return {
    tryTake(n: number): boolean {
      refill();
      if (tokens < n) {
        return false;
      }
      tokens -= n;
      return true;
    },
  };
}
