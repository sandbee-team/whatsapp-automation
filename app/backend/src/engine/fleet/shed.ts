import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';
import type { InstanceId } from './types.js';

/**
 * shed.ts (P09 Unit U4, step 6) - least-harm shed victim selection and
 * execution, plus no-taker detection.
 *
 * PLACEMENT NEUTRALITY (guarded next wave): this module may not import any
 * health-scoring, pause, restriction-history or IP module - victim choice
 * is purely a function of the injected `SessionInventory` snapshot shape
 * below (recency/idle/queue-depth), nothing else.
 *
 * SAFETY BOUNDARY: shedding is capacity movement, never account action. The
 * module graph below is structurally unable to reach `logout()`/`unlink()`:
 * `shedVictims` only ever calls the two INJECTED ports `endSocket` (=
 * `sock.end()`, never `sock.logout()`) and `releaseLeaseGracefully` (the
 * graceful, voluntary lease release - `LeaseManager.release()`'s wiring,
 * never a forced/park path). No pairing controller, ChannelLink, or any
 * module that transitively imports them is imported here.
 *
 * `chooseShedVictims(candidates, n)` is the function the admission
 * controller's injected `victimChooser` (see `admission.ts`) points at in
 * wiring - it takes an explicit candidate snapshot rather than reading a
 * registry itself, so it stays a pure, deterministic function over a
 * fixture set.
 */

/**
 * One row of the snapshot list a later wiring unit adapts the real session
 * registry into. `acquiredAtMonotonic`/`lastConversationActivityAtMonotonic`
 * are both monotonic timestamps (e.g. `performance.now()`), never
 * wall-clock - comparable directly against the `now` argument callers pass
 * to `chooseShedVictims`.
 */
export interface ShedCandidate {
  readonly instanceId: InstanceId;
  readonly clientId: string;
  readonly acquiredAtMonotonic: number;
  readonly inFlightSendCount: number;
  readonly lastConversationActivityAtMonotonic: number | null;
  readonly queueDepth: number;
  readonly pairingInProgress: boolean;
}

/** Injected `SessionInventory` port - a later wiring unit adapts the real session registry to this shape. */
export interface SessionInventory {
  snapshot(): ShedCandidate[];
}

/** No-taker detection window: a shed victim not re-owned within this many scan cycles increments `wp_shed_no_taker_total`. */
const NO_TAKER_CYCLE_WINDOW = 2;

/** Idle threshold: no conversation activity within this many ms (relative to `now`) counts as idle for tie-breaking, same as "no in-flight" — both are required for the idle side of the tie-break to beat active. */
const IDLE_THRESHOLD_MS = 60_000;

function isIdle(candidate: ShedCandidate, now: number): boolean {
  // "no in-flight AND no conversation activity within 60s" - candidates
  // reaching this point already have inFlightSendCount === 0 (excluded
  // otherwise), so idle reduces to the conversation-activity check.
  if (candidate.lastConversationActivityAtMonotonic === null) {
    return true;
  }
  return now - candidate.lastConversationActivityAtMonotonic >= IDLE_THRESHOLD_MS;
}

/**
 * Victim selection comparator (documented exactly, for the deterministic
 * fixture tests):
 *
 *   1. EXCLUDE any candidate with `inFlightSendCount > 0` OR
 *      `pairingInProgress` - regardless of ordering score.
 *   2. Among the remainder, order by `acquiredAtMonotonic` DESCENDING
 *      (most-recently-acquired first).
 *   3. Tie-break by idle-ness: idle (no in-flight AND no conversation
 *      activity within 60s) beats active.
 *   4. Further tie-break by `queueDepth` ASCENDING (smallest first).
 *   5. Any remaining tie keeps original input order (stable sort).
 *
 * `now` defaults to `Date.now()` but should be passed explicitly by callers
 * that need determinism against `lastConversationActivityAtMonotonic`
 * (a monotonic clock, so tests pass their own reference point).
 */
export function chooseShedVictims(
  candidates: readonly ShedCandidate[],
  n: number,
  now: number = Date.now(),
): InstanceId[] {
  const eligible = candidates.filter((c) => c.inFlightSendCount === 0 && !c.pairingInProgress);

  const scored = eligible.map((candidate, index) => ({
    candidate,
    index,
    idle: isIdle(candidate, now),
  }));

  scored.sort((a, b) => {
    if (a.candidate.acquiredAtMonotonic !== b.candidate.acquiredAtMonotonic) {
      return b.candidate.acquiredAtMonotonic - a.candidate.acquiredAtMonotonic;
    }
    if (a.idle !== b.idle) {
      return a.idle ? -1 : 1;
    }
    if (a.candidate.queueDepth !== b.candidate.queueDepth) {
      return a.candidate.queueDepth - b.candidate.queueDepth;
    }
    return a.index - b.index;
  });

  return scored.slice(0, n).map((s) => s.candidate.instanceId);
}

/** Injected socket/lease ports `shedVictims` executes against - both received, never a raw session registry. */
export interface ShedPorts {
  /** `sock.end()` - never `logout()`/`unlink()`. */
  endSocket(instanceId: InstanceId): Promise<void>;
  /** The graceful, voluntary release that writes the released marker (`LeaseManager.release()`'s wiring) - so another worker can re-grab promptly, never a forced/park path. */
  releaseLeaseGracefully(instanceId: InstanceId): Promise<void>;
}

export interface ShedResult {
  instanceId: InstanceId;
  ok: boolean;
  error?: unknown;
  /** WARNING FIX 4: whether `endSocket` succeeded for this victim, tracked separately from `releaseOk` so a throwing `endSocket` never silently skips the (still attempted) graceful release. */
  endOk: boolean;
  /** WARNING FIX 4: whether `releaseLeaseGracefully` succeeded for this victim - attempted even when `endSocket` threw. */
  releaseOk: boolean;
}

/**
 * Executes a shed for each victim in order: `endSocket` then
 * `releaseLeaseGracefully`. WARNING FIX 4: the two legs are now in
 * SEPARATE try/catch blocks - previously a throwing `endSocket` skipped
 * `releaseLeaseGracefully` entirely for that victim (a single try wrapping
 * both), leaving a lease held that could otherwise have been released
 * cleanly. Both outcomes are recorded independently in `ShedResult`
 * (`endOk`/`releaseOk`); `ok` is `true` only when BOTH legs succeeded. An
 * error on either leg for one victim does NOT abort the remaining victims -
 * a failed release is reported, never retried blindly (core invariant 2).
 */
export async function shedVictims(
  victims: readonly InstanceId[],
  ports: ShedPorts,
): Promise<ShedResult[]> {
  const results: ShedResult[] = [];

  for (const instanceId of victims) {
    let endOk = true;
    let releaseOk = true;
    let error: unknown;

    try {
      await ports.endSocket(instanceId);
    } catch (err) {
      endOk = false;
      error = err;
    }

    try {
      await ports.releaseLeaseGracefully(instanceId);
    } catch (err) {
      releaseOk = false;
      error = error ?? err;
    }

    const ok = endOk && releaseOk;
    results.push(
      ok ? { instanceId, ok, endOk, releaseOk } : { instanceId, ok, endOk, releaseOk, error },
    );
  }

  return results;
}

// ---------------------------------------------------------------------
// No-taker detection: a shed instance not re-grabbed within two scan
// cycles increments wp_shed_no_taker_total.
// ---------------------------------------------------------------------

export interface ShedMetricsHandles {
  noTakerTotal: ReturnType<MetricsRegistry['counter']>;
  shedsTotal: ReturnType<MetricsRegistry['counter']>;
  incrementNoTaker: () => void;
  incrementSheds: () => void;
}

const registeredMetrics = new WeakMap<MetricsRegistry, ShedMetricsHandles>();

/** Idempotent registration (WeakMap-keyed-by-registry pattern from `platform/metrics/lease-metrics.ts`). No `instance_id` label - enforced allow-list. */
export function bindShedMetrics(registry: MetricsRegistry = defaultMetrics): ShedMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const noTakerTotal = registry.counter(
    'wp_shed_no_taker_total',
    'Shed instances not re-grabbed by another worker within two scan cycles',
  );
  const shedsTotal = registry.counter(
    'wp_worker_sheds_total',
    'Total sessions shed by this worker',
  );

  const handles: ShedMetricsHandles = {
    noTakerTotal,
    shedsTotal,
    incrementNoTaker: () => {
      noTakerTotal.inc();
    },
    incrementSheds: () => {
      shedsTotal.inc();
    },
  };

  registeredMetrics.set(registry, handles);
  return handles;
}

interface PendingShed {
  instanceId: InstanceId;
  shedAtCycle: number;
}

export interface NoTakerTrackerDeps {
  /** Freshness check backed by `lease_seen_at` - wiring provides the real implementation. */
  isOwned(instanceId: InstanceId): Promise<boolean>;
  metrics?: ShedMetricsHandles;
}

/**
 * Tracks sheds and checks, `NO_TAKER_CYCLE_WINDOW` (2) scan cycles later,
 * whether each one was re-grabbed. `recordShed` is called once per shed
 * (right after `shedVictims`); `checkNoTakers(currentCycle)` is called once
 * per scan cycle (an explicit cycle count, rather than an internal
 * `onScanCycle()` hook, so the caller controls exactly when checks run).
 */
export function createNoTakerTracker(deps: NoTakerTrackerDeps): {
  recordShed(instanceId: InstanceId, shedAtCycle: number): void;
  checkNoTakers(currentCycle: number): Promise<void>;
} {
  const metrics = deps.metrics ?? bindShedMetrics();
  const pending: PendingShed[] = [];

  return {
    recordShed(instanceId: InstanceId, shedAtCycle: number): void {
      pending.push({ instanceId, shedAtCycle });
    },

    async checkNoTakers(currentCycle: number): Promise<void> {
      const due = pending.filter((p) => currentCycle - p.shedAtCycle >= NO_TAKER_CYCLE_WINDOW);
      if (due.length === 0) {
        return;
      }

      // Remove the due entries up front - a failed isOwned check must not
      // re-queue the same entry for a later cycle (checked exactly once).
      for (const entry of due) {
        const idx = pending.indexOf(entry);
        if (idx !== -1) {
          pending.splice(idx, 1);
        }
      }

      for (const entry of due) {
        const owned = await deps.isOwned(entry.instanceId);
        if (!owned) {
          metrics.incrementNoTaker();
        }
      }
    },
  };
}
