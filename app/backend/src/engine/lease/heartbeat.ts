import { TIMING } from '@wp/domain';
import type { WorkerDb } from '@wp/db';
import { tenantKey } from '../../platform/redis/keys.js';
import { renewBatch as pgRenewBatch, type RenewBatchResult } from './lease-state-repo.js';
import type { LeaseRedis } from './lease-redis.js';
import {
  evaluatePgFenceConflict,
  evaluateRedisRenewLoss,
  evaluateWatchdog,
  type SelfFenceDecision,
  type WatchdogState,
} from './self-fence.js';
import type { FenceLostCause, SessionOwner } from './session-owner.port.js';
import type { SessionLease } from './lease-manager.js';

/**
 * heartbeat.ts (P06 Unit U5) - the held-lease set plus the ONE-round-trip
 * renew tick. Never a per-lease loop (ADR 0018 S4 / scope-delta row 2): one
 * `lease-redis.renewBatch` call and one `lease-state-repo.renewBatch`
 * statement cover EVERY held lease, every tick, regardless of how many
 * leases are held (25 or 1,000+).
 *
 * On any self-fence decision (see `self-fence.ts`): calls
 * `SessionOwner.onFenceLost(instanceId, cause)`, drops the lease from the
 * held set, and increments `wp_lease_lost_total{cause}` - and does NOT
 * write a Postgres release, does NOT delete the Redis key. We may not own
 * either any more (fail-safe: core invariant 2 - never touch state you are
 * not certain you still own).
 *
 * `isClaimingAllowed()` is false from the first PG renew failure
 * (`ok: false`) until the next SUCCESSFUL PG renew - P11's claim loop is the
 * intended consumer (documented here since it does not exist yet): while
 * Postgres's liveness signal is unknown, this worker must not start new
 * claims for the instances it holds, but it also must not treat that
 * uncertainty as a fence loss (scope-delta row 12).
 */

export interface HeartbeatMetricsPort {
  incrementLeaseLost(cause: FenceLostCause): void;
  incrementTicksSkipped(): void;
}

const NOOP_METRICS: HeartbeatMetricsPort = {
  incrementLeaseLost: () => undefined,
  incrementTicksSkipped: () => undefined,
};

export interface HeartbeatDeps {
  leaseRedis: LeaseRedis;
  /** A `WorkerDb` (`@wp/db`'s `createWorkerDb`, or a test wrapper) - passed directly to `lease-state-repo.ts`'s `renewBatch`, which pins `app.worker_id` and the renew statement to one shared transaction (C1 finding 2). */
  pgSql: WorkerDb;
  sessionOwner: SessionOwner;
  workerId: string;
  env: string;
  timing?: typeof TIMING;
  metrics?: HeartbeatMetricsPort;
  /** Injectable monotonic clock - NEVER `Date.now()` (self-fence.ts's module doc). Defaults to `process.hrtime.bigint`. */
  monotonicNow?: () => bigint;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

const DEFAULT_MONOTONIC_NOW = (): bigint => process.hrtime.bigint();

export class LeaseHeartbeat {
  private readonly leaseRedis: LeaseRedis;
  private readonly pgSql: WorkerDb;
  private readonly sessionOwner: SessionOwner;
  private readonly workerId: string;
  private readonly env: string;
  private readonly timing: typeof TIMING;
  private readonly metrics: HeartbeatMetricsPort;
  private readonly monotonicNow: () => bigint;
  private readonly setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;

  private readonly heldLeases = new Map<string, SessionLease>();
  private readonly watchdogState = new Map<string, bigint>();
  private claimingAllowed = true;
  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  /**
   * ALL currently in-flight ticks (normally at most one, since `tick()`
   * skips a call while one is already running - see `tick()`'s doc). Tracked
   * as a Set, not a single field, so `stop()` awaits every one of them, not
   * just "the most recently started" - matters even under the skip guard
   * because a caller could invoke `tick()` directly (bypassing `start()`'s
   * interval) while a previous direct call is still settling.
   */
  private readonly ticksInFlight = new Set<Promise<void>>();
  /** The single currently-running tick, if any - `tick()`'s re-entrancy guard checks this to skip a second concurrent call. */
  private currentTick: Promise<void> | undefined;

  constructor(deps: HeartbeatDeps) {
    this.leaseRedis = deps.leaseRedis;
    this.pgSql = deps.pgSql;
    this.sessionOwner = deps.sessionOwner;
    this.workerId = deps.workerId;
    this.env = deps.env;
    this.timing = deps.timing ?? TIMING;
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.monotonicNow = deps.monotonicNow ?? DEFAULT_MONOTONIC_NOW;
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  private leaseKey(clientId: string, instanceId: string): string {
    return tenantKey(this.env, clientId, 'lease', 'i', instanceId);
  }

  /** Adds a lease to the held set, seeding its watchdog baseline to "now" (a fresh acquire counts as a successful renewal). */
  add(lease: SessionLease): void {
    this.heldLeases.set(lease.instanceId, lease);
    this.watchdogState.set(lease.instanceId, this.monotonicNow());
  }

  /** Drops a lease from the held set (voluntary release, or after a self-fence decision). */
  remove(instanceId: string): void {
    this.heldLeases.delete(instanceId);
    this.watchdogState.delete(instanceId);
  }

  /** Snapshot of every currently-held lease. */
  held(): SessionLease[] {
    return [...this.heldLeases.values()];
  }

  isClaimingAllowed(): boolean {
    return this.claimingAllowed;
  }

  /**
   * Runs exactly one heartbeat tick: empty held set short-circuits with NO
   * round trips at all (not even an empty-array call) - there is nothing to
   * renew. Otherwise issues ONE `lease-redis.renewBatch` covering every held
   * lease, awaits it (catching a rejection - Redis unreachable/hung feeds
   * only the watchdog deadline, never an immediate fence loss), then ONE
   * `lease-state-repo.renewBatch` statement, then evaluates all three
   * self-fence triggers and applies their decisions.
   *
   * Re-entrancy: if a tick is ALREADY in flight, a new call SKIPS starting a
   * second `runTick()` (counted via `metrics.incrementTicksSkipped()`)
   * instead of overlapping it - a slow-but-alive PG/Redis leg that outlives
   * `heartbeatMs` must never compound into multiple concurrent renew
   * statements (ADR 0018 S4's retry-storm shape). The skipped call resolves
   * once the in-flight tick settles, so callers awaiting `tick()` never see
   * it resolve early relative to the tick actually running.
   */
  async tick(): Promise<void> {
    const existing = this.currentTick;
    if (existing) {
      this.metrics.incrementTicksSkipped();
      return existing;
    }

    const run = this.runTick();
    this.currentTick = run;
    this.ticksInFlight.add(run);
    try {
      await run;
    } finally {
      this.ticksInFlight.delete(run);
      if (this.currentTick === run) {
        this.currentTick = undefined;
      }
    }
  }

  private async runTick(): Promise<void> {
    const leases = this.held();
    if (leases.length === 0) {
      return;
    }

    const instanceIds = leases.map((lease) => lease.instanceId);

    // --- Redis renew (one round trip) ---
    let redisRenewed: (boolean | undefined)[];
    try {
      const entries = leases.map((lease) => ({
        key: this.leaseKey(lease.clientId, lease.instanceId),
        value: `${lease.workerId}|${lease.fence.toString()}`,
      }));
      const results = await this.leaseRedis.renewBatch(entries, this.timing.leaseTtlMs);
      redisRenewed = results;
      // Advance the watchdog baseline for every instance whose renewal
      // explicitly succeeded this tick - but ONLY if it is still actually
      // held. An instance removed mid-tick (remove()-mid-tick race) must
      // never be re-inserted into `watchdogState` with a fresh baseline; it
      // is not ours to track any more.
      instanceIds.forEach((instanceId, index) => {
        if (results[index] === true && this.heldLeases.has(instanceId)) {
          this.watchdogState.set(instanceId, this.monotonicNow());
        }
      });
    } catch {
      // Redis call rejected (unreachable/hung) - no per-instance signal;
      // feeds only the watchdog deadline below. Never an immediate
      // redis_renew_lost.
      redisRenewed = instanceIds.map(() => undefined);
    }

    const redisDecisions = evaluateRedisRenewLoss({ instanceIds, redisRenewed });

    // --- Postgres renew (one statement) ---
    const pgResult: RenewBatchResult = await pgRenewBatch(this.pgSql, {
      workerId: this.workerId,
      leases: leases.map((lease) => ({ instanceId: lease.instanceId, fence: lease.fence })),
    });

    let pgDecisions: SelfFenceDecision[] = [];
    if (pgResult.ok) {
      this.claimingAllowed = true;
      pgDecisions = evaluatePgFenceConflict({ instanceIds, pgResult });
    } else {
      // PG unavailable/timeout: explicit non-trigger. Claiming is disallowed
      // until the next successful PG renew; no lease is touched.
      this.claimingAllowed = false;
    }

    // --- Watchdog (monotonic-only) ---
    // An instance from the tick-start snapshot with NO `watchdogState` entry
    // by now was removed mid-tick (remove()-mid-tick race) - it is not ours
    // to fence any more. SKIP it entirely: never synthesize a fresh
    // `monotonicNow()` baseline for it (that would silently treat "unknown"
    // as "just renewed", the opposite of fail-safe - core invariant 2), and
    // never fence it either.
    const watchdogStates: WatchdogState[] = [];
    for (const instanceId of instanceIds) {
      const lastRenewedAtNs = this.watchdogState.get(instanceId);
      if (lastRenewedAtNs === undefined) {
        continue;
      }
      watchdogStates.push({ instanceId, lastRenewedAtNs });
    }
    const watchdogDecisions = evaluateWatchdog({
      watchdogStates,
      nowNs: this.monotonicNow(),
      watchdogMs: this.timing.watchdogMs,
    });

    // De-duplicate by instance (an instance may match more than one
    // trigger in the same tick) - first decision wins, in a fixed
    // redis -> pg -> watchdog priority order.
    const decided = new Map<string, SelfFenceDecision>();
    for (const decision of [...redisDecisions, ...pgDecisions, ...watchdogDecisions]) {
      if (!decided.has(decision.instanceId)) {
        decided.set(decision.instanceId, decision);
      }
    }

    for (const decision of decided.values()) {
      this.sessionOwner.onFenceLost(decision.instanceId, decision.cause);
      this.remove(decision.instanceId);
      this.metrics.incrementLeaseLost(decision.cause);
    }
  }

  /** Starts the recurring `timing.heartbeatMs` tick. Idempotent - a second `start()` call while already running is a no-op. */
  start(): void {
    if (this.intervalHandle !== undefined) {
      return;
    }
    this.intervalHandle = this.setIntervalFn(() => {
      void this.tick();
    }, this.timing.heartbeatMs);
  }

  /** Stops the recurring tick and awaits EVERY in-flight tick before resolving (not just the most recently started one). */
  async stop(): Promise<void> {
    if (this.intervalHandle !== undefined) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    await Promise.all(this.ticksInFlight);
  }
}

/** Convenience factory mirroring other engine modules' `create*` pattern. */
export function createLeaseHeartbeat(deps: HeartbeatDeps): LeaseHeartbeat {
  return new LeaseHeartbeat(deps);
}
