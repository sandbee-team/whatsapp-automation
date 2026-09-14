import type { Redis } from 'ioredis';
import type { createPool } from '@wp/db';
import type { DiscoveryMetricsHandles } from '../../platform/metrics/discovery-metrics.js';
import type { DiscoveryRow } from './discovery.js';

/**
 * discovery-types.ts (FIX-P09-B split) - the `DiscoveryDeps`/`AdmissionPort`/
 * `DiscoveryLoop` interfaces, mechanically extracted out of `discovery.ts`
 * for the max-lines cap. `discovery.ts` still imports this module (keeping
 * it covered by the placement-neutrality/shutdown-purity guards) and
 * re-exports every symbol so existing import paths keep working unchanged.
 * No logic change.
 */

export interface AdmissionPort {
  canAcceptLease(): { ok: boolean; state: string; reason?: string };
}

export interface DiscoveryDeps {
  pool: Pick<ReturnType<typeof createPool>, 'query'>;
  redis: Redis;
  env: string;
  workerId: string;
  admission: AdmissionPort;
  /** Grabs (leases + starts) the given row - `true` on success, `false` on a lost race/failure. Real grab lands in a later wiring unit; tests inject a spy. */
  grab(row: DiscoveryRow): Promise<boolean>;
  /** Marks `INFRA_UNAVAILABLE` for a client-scoped instance - defaults to `markInfraUnavailableIfChanged` bound to a per-client queryable the caller supplies via `withTenant`. */
  markInfraUnavailable(row: DiscoveryRow): Promise<boolean>;
  /**
   * WARNING FIX 5 - re-verifies ownership freshness for an instance still
   * unowned-after-a-failed-grab THIS cycle, before it counts toward (or
   * resets) the escalation streak: `true` means someone else's lease is
   * fresh (a healthy, contended instance - the streak must reset/skip, not
   * escalate), `false` means genuinely unowned (the streak counts
   * normally). OPTIONAL - defaults to always `false` (every failed-grab
   * cycle counts toward escalation, the PRE-FIX behavior) so callers that
   * do not wire this keep their existing behavior unchanged.
   */
  isOwnershipFresh?(row: DiscoveryRow): Promise<boolean>;
  getLagP99Ms(): number;
  getCap(): number;
  getCurrentSessions(): number;
  maxRows?: number;
  staleMs?: number;
  metrics?: DiscoveryMetricsHandles;
  /** Injected scheduler for the interval timer - defaults to real `setTimeout`. Tests drive `runOneCycle` directly instead of relying on this. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  random?: () => number;
  /** Logger sink for cycle-level failures - defaults to `console.error`. */
  onCycleError?: (err: unknown) => void;
}

export interface DiscoveryLoop {
  /** Runs exactly ONE discovery cycle - the test seam; production wiring calls this on the injected-interval timer. */
  runOneCycle(): Promise<void>;
  start(): void;
  stop(): void;
}
