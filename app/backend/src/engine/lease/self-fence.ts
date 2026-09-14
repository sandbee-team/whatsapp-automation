import type { FenceLostCause } from './session-owner.port.js';

/**
 * self-fence.ts (P06 Unit U5) - the PURE trigger decision for one heartbeat
 * tick. Zero I/O: no Redis, no Postgres, no timers - `heartbeat.ts` is the
 * only caller, and it owns every side effect (the actual `onFenceLost`
 * call, dropping the lease, incrementing metrics).
 *
 * Self-fence triggers are EXACTLY three (ADR 0018 S4 / scope-delta row 12):
 *
 *   (a) `redis_renew_lost` - the Redis renew array returned `0`/`false` for
 *       that instance's key this tick (Redis explicitly says we no longer
 *       hold the key).
 *   (b) `pg_fence_conflict` - a SUCCESSFUL Postgres renew (`ok: true`)
 *       omitted that instance from `renewed` (Postgres explicitly says our
 *       fence is no longer current, or we are no longer the owner - the two
 *       are indistinguishable by design, both are fence conflicts).
 *   (c) `watchdog` - no SUCCESSFUL Redis renewal has completed for that
 *       instance within `watchdogMs`, measured EXCLUSIVELY on a monotonic
 *       clock (`monotonicNow()`, i.e. `process.hrtime.bigint()` in
 *       production - NEVER `Date.now()`, which can jump backwards on NTP
 *       correction or manual clock changes and would delay or skip the
 *       deadline). Fires for EVERY held lease whose last successful renewal
 *       is older than the deadline, not just the one(s) that failed this
 *       tick.
 *
 * EXPLICIT NON-TRIGGERS (the single easiest way to fail this phase):
 *
 *   - ANY Postgres error/timeout/unavailability (`ok: false`, or the call
 *     never resolves in time) - core invariant 2 forbids treating "the
 *     database is down" as "I lost my lease". A PG failure feeds NOTHING
 *     into this decision (no cause, no lease dropped) - it only affects
 *     `isClaimingAllowed()` (heartbeat.ts's concern, not this module's).
 *   - A Redis renew REJECTION (as opposed to a returned `0`) - a rejection
 *     means "Redis unreachable/hung", not "Redis said no". A rejection
 *     feeds ONLY the watchdog deadline (no successful renewal happened this
 *     tick), never an immediate `redis_renew_lost`.
 *
 * SAFETY BOUNDARY: self-fencing releases a lease; it never re-links, never
 * rotates numbers, never picks another number, and never auto-resumes a
 * paused/restricted instance (safety-compliance skill, core invariant 6).
 */

export interface SelfFenceDecision {
  instanceId: string;
  cause: FenceLostCause;
}

/** One held lease's watchdog bookkeeping, tracked by `heartbeat.ts`. */
export interface WatchdogState {
  instanceId: string;
  /** Monotonic timestamp (ns, `process.hrtime.bigint()` units) of the last SUCCESSFUL renewal. */
  lastRenewedAtNs: bigint;
}

export interface EvaluateRedisOutcomeInput {
  /** Every held instance id, positionally aligned with `redisRenewed`. */
  instanceIds: readonly string[];
  /**
   * The Redis renew result for this tick: `true`/`false` per instance if the
   * call resolved, or `undefined` (the whole call REJECTED - Redis
   * unreachable/hung) - a rejection carries no per-instance information, so
   * every instance is `undefined` in that case.
   */
  redisRenewed: readonly (boolean | undefined)[];
}

/**
 * Evaluates ONLY the Redis-renew-lost trigger (a). Returns one decision per
 * instance whose renew explicitly resolved `false` this tick. A rejected
 * call (every entry `undefined`) yields no decisions here - it only affects
 * the watchdog deadline, evaluated separately by `evaluateWatchdog`.
 */
export function evaluateRedisRenewLoss(input: EvaluateRedisOutcomeInput): SelfFenceDecision[] {
  const decisions: SelfFenceDecision[] = [];
  input.instanceIds.forEach((instanceId, index) => {
    if (input.redisRenewed[index] === false) {
      decisions.push({ instanceId, cause: 'redis_renew_lost' });
    }
  });
  return decisions;
}

export interface EvaluatePgOutcomeInput {
  /** Every held instance id this tick attempted to renew via Postgres. */
  instanceIds: readonly string[];
  /**
   * The Postgres renew outcome for this tick - mirrors
   * `lease-state-repo.ts`'s `RenewBatchResult` exactly. `ok: false` (PG
   * unavailable/timeout) yields NO decisions (see module doc's explicit
   * non-trigger).
   */
  pgResult: { ok: true; renewed: ReadonlySet<string> } | { ok: false; error: unknown };
}

/**
 * Evaluates ONLY the PG-fence-conflict trigger (b). A `pgResult.ok: false`
 * (Postgres unavailable/timeout) is the explicit non-trigger: returns `[]`
 * unconditionally, never conflated with a fence conflict.
 */
export function evaluatePgFenceConflict(input: EvaluatePgOutcomeInput): SelfFenceDecision[] {
  if (!input.pgResult.ok) {
    return [];
  }

  const renewed = input.pgResult.renewed;
  const decisions: SelfFenceDecision[] = [];
  for (const instanceId of input.instanceIds) {
    if (!renewed.has(instanceId)) {
      decisions.push({ instanceId, cause: 'pg_fence_conflict' });
    }
  }
  return decisions;
}

export interface EvaluateWatchdogInput {
  /** Every held lease's last-successful-Redis-renewal bookkeeping. */
  watchdogStates: readonly WatchdogState[];
  /** Current monotonic time (ns) - the caller's injected `monotonicNow()`, never `Date.now()`. */
  nowNs: bigint;
  /** `TIMING.watchdogMs` (or a compressed override in tests). */
  watchdogMs: number;
}

/**
 * Evaluates ONLY the watchdog trigger (c): every held lease whose last
 * successful Redis renewal is older than `watchdogMs` (measured on the
 * monotonic clock) self-fences with cause `'watchdog'`. Fires for EVERY
 * such lease, not just ones touched this tick - a lease that has NEVER
 * successfully renewed (fresh acquire, immediate hang) is measured from
 * whatever `lastRenewedAtNs` baseline the caller seeded at acquire time.
 */
export function evaluateWatchdog(input: EvaluateWatchdogInput): SelfFenceDecision[] {
  const deadlineNs = BigInt(input.watchdogMs) * 1_000_000n;
  const decisions: SelfFenceDecision[] = [];
  for (const state of input.watchdogStates) {
    const elapsedNs = input.nowNs - state.lastRenewedAtNs;
    if (elapsedNs >= deadlineNs) {
      decisions.push({ instanceId: state.instanceId, cause: 'watchdog' });
    }
  }
  return decisions;
}
