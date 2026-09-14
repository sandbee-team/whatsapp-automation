/**
 * scripts/measure/pacing-run.ts (P26 U5, step 5) - the PURE half of the
 * 1,000-instance pacing-run + M14 burst harness: cap-violation detection
 * over ledger-vs-state ROWS (never a harness tally - invariant 7), percentile
 * math, and the M14 fairness verdict. No pg/ioredis/app-backend import here -
 * the runnable half lives in `app/backend/src/engine/measure/run-pacing.ts`
 * (same split as `scale-fleet.ts`/`scale-fleet-child.ts`). The artifact
 * schema + `buildPacingRunArtifact` live in the max-lines split sibling
 * `pacing-run-artifact.ts`; the validator/summary/`--verify` CLI in
 * `pacing-run-verify.ts` (idiom: `session-worker-discovery-wiring.ts`).
 */

// ---------------------------------------------------------------------
// Cap-violation detection (row-based - never a harness tally).
// ---------------------------------------------------------------------

export interface LedgerRow {
  instanceId: string;
  clientId: string;
  ledgerDate: string;
  consumedCount: number;
  sentThisHour: number;
  hourKey: number;
  newConvCount: number;
  groupSentCount: number;
}

export interface PacingStateRow {
  instanceId: string;
  clientId: string;
  effDailyCap: number;
  effHourlyCap: number;
  effNewConvCap: number;
  effGroupDailyCap: number;
}

export interface ClientUsageRow {
  clientId: string;
  sentCount: number;
  cap: number | null;
}

export type CapViolationKind =
  'daily' | 'hourly' | 'new-conv' | 'group-daily' | 'client-daily' | 'orphan-ledger-row';

export interface CapViolation {
  instanceId: string;
  kind: CapViolationKind;
  observed: number;
  limit: number;
}

/**
 * Compares `ledger` rows against matching `state` rows (and, optionally,
 * `clientUsage` against its plan cap) - `[]` means a genuinely clean run
 * (caller seeds caps so approach-to-cap is realistic - see run-pacing.ts).
 * A ledger row with NO matching state row is kind `'orphan-ledger-row'`
 * (limit `-1`) - the run's OWN bookkeeping is broken, never "no violation".
 */
export function findCapViolations(
  ledger: readonly LedgerRow[],
  state: readonly PacingStateRow[],
  clientUsage?: readonly ClientUsageRow[],
): CapViolation[] {
  const stateByInstance = new Map(state.map((s) => [s.instanceId, s]));
  const violations: CapViolation[] = [];

  for (const row of ledger) {
    const st = stateByInstance.get(row.instanceId);
    if (!st) {
      violations.push({
        instanceId: row.instanceId,
        kind: 'orphan-ledger-row',
        observed: row.consumedCount,
        limit: -1,
      });
      continue;
    }
    if (row.consumedCount > st.effDailyCap) {
      violations.push({
        instanceId: row.instanceId,
        kind: 'daily',
        observed: row.consumedCount,
        limit: st.effDailyCap,
      });
    }
    if (row.sentThisHour > st.effHourlyCap) {
      violations.push({
        instanceId: row.instanceId,
        kind: 'hourly',
        observed: row.sentThisHour,
        limit: st.effHourlyCap,
      });
    }
    if (row.newConvCount > st.effNewConvCap) {
      violations.push({
        instanceId: row.instanceId,
        kind: 'new-conv',
        observed: row.newConvCount,
        limit: st.effNewConvCap,
      });
    }
    if (row.groupSentCount > st.effGroupDailyCap) {
      violations.push({
        instanceId: row.instanceId,
        kind: 'group-daily',
        observed: row.groupSentCount,
        limit: st.effGroupDailyCap,
      });
    }
  }

  for (const usage of clientUsage ?? []) {
    if (usage.cap !== null && usage.sentCount > usage.cap) {
      violations.push({
        instanceId: usage.clientId,
        kind: 'client-daily',
        observed: usage.sentCount,
        limit: usage.cap,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------
// Percentile math.
// ---------------------------------------------------------------------

/**
 * Exact percentile via linear interpolation between closest ranks (the
 * "R-7" / Excel `PERCENTILE.INC` method): rank = `p/100 * (n-1)`,
 * interpolated between `floor(rank)` and `ceil(rank)` by the fractional
 * part. `p` in `[0, 100]`. Sorts a COPY (never mutates input). Throws on an
 * empty array - zero samples has no meaningful percentile.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    throw new Error('percentile: cannot compute a percentile of an empty array');
  }
  if (!(p >= 0 && p <= 100)) {
    throw new Error(`percentile: p must be in [0, 100], got ${String(p)}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex] as number;
  const upper = sorted[upperIndex] as number;
  const frac = rank - lowerIndex;
  return lower + (upper - lower) * frac;
}

// ---------------------------------------------------------------------
// M14 fairness verdict.
// ---------------------------------------------------------------------

export interface FairnessVerdictInput {
  baselineP99Ms: number;
  duringBurstP99Ms: number;
  /** Max fraction the during-burst p99 may exceed baseline by. Default 0.20 (M14). */
  tolerance?: number;
}

export interface FairnessVerdictResult {
  ok: boolean;
  /** `null` when the baseline window carried no samples - an UNMEASURED window is never a number. */
  ratio: number | null;
  note: string;
}

const DEFAULT_FAIRNESS_TOLERANCE = 0.2;

/**
 * `ratio = duringBurstP99Ms / baselineP99Ms`; `ok` iff `ratio <= 1 + tolerance`.
 *
 * A NON-POSITIVE `baselineP99Ms` means the before-burst window carried no
 * claim samples at all: the comparison is not computable, so this returns
 * `ratio: null` with a NAMED reason and `ok: false` - it never divides. The
 * old behaviour (dividing to `Infinity`) reported "fairness measured and
 * failed" for a run in which fairness was never measured, which is exactly
 * how the P26 smoke's `ratio Infinity` masked a mis-bucketed sampler.
 */
export function fairnessVerdict(input: FairnessVerdictInput): FairnessVerdictResult {
  const tolerance = input.tolerance ?? DEFAULT_FAIRNESS_TOLERANCE;
  if (!(input.baselineP99Ms > 0)) {
    return {
      ok: false,
      ratio: null,
      note:
        `fairness not computable: baseline p99 is ${String(input.baselineP99Ms)}ms - ` +
        'no claim samples in the before window',
    };
  }
  const ratio = input.duringBurstP99Ms / input.baselineP99Ms;
  const ok = ratio <= 1 + tolerance;
  const note = ok
    ? `during-burst p99 (${String(input.duringBurstP99Ms)}ms) is within ${String(tolerance * 100)}% of baseline (${String(input.baselineP99Ms)}ms) - ratio ${ratio.toFixed(4)}`
    : `during-burst p99 (${String(input.duringBurstP99Ms)}ms) exceeds ${String(tolerance * 100)}% tolerance over baseline (${String(input.baselineP99Ms)}ms) - ratio ${ratio.toFixed(4)}`;
  return { ok, ratio, note };
}

// ---------------------------------------------------------------------
// Fairness-window bucketing + run precondition.
// ---------------------------------------------------------------------

/**
 * Buckets ONE claim sample taken at the ABSOLUTE instant `sampleAtMs` into
 * the before- or during-burst fairness window, given the ABSOLUTE instant
 * the burst fires at (`runStartMs + burstAtSeconds * 1000`). A sample exactly
 * at the burst instant counts as `during`.
 *
 * Both arguments MUST be the same kind of quantity (epoch milliseconds).
 * Passing a RUN-RELATIVE offset as `burstAtMs` while sampling epoch times
 * puts every sample in `during` - that mismatch is the P26 smoke's
 * `before=0 during=237` and the reason this comparison is a named,
 * clock-injected function instead of an inline `Date.now() < burstAtMs`.
 */
export function bucketClaimSample(sampleAtMs: number, burstAtMs: number): 'before' | 'during' {
  return sampleAtMs < burstAtMs ? 'before' : 'during';
}

export interface SendClassInterval {
  key: string;
  intervalMs: number;
}

export interface PlanCanSendWithinResult {
  ok: boolean;
  reason: string | null;
}

/**
 * Refuses a run whose duration is shorter than even the FASTEST tenant
 * class's per-instance send interval: such a run enqueues nothing at all and
 * reports `jobs.enqueued=0`, which is indistinguishable from a mis-scoped
 * collection query. The named reason prints both numbers and the minimum
 * `--minutes` that would work, so the operator never has to guess which of
 * the two causes they are looking at (P26 smoke, defect 3).
 */
export function planCanSendWithin(
  classes: readonly SendClassInterval[],
  durationMs: number,
): PlanCanSendWithinResult {
  const prefix = 'no tenant class can send even once within the run: ';
  if (classes.length === 0) {
    return { ok: false, reason: `${prefix}the plan is empty` };
  }
  const fastest = classes.reduce((a, b) => (b.intervalMs < a.intervalMs ? b : a));
  if (fastest.intervalMs <= durationMs) return { ok: true, reason: null };
  const neededMinutes = Math.ceil(fastest.intervalMs / 60_000);
  return {
    ok: false,
    reason:
      `${prefix}the fastest class "${fastest.key}" sends every ` +
      `${String(Math.round(fastest.intervalMs / 1000))}s but the run is only ` +
      `${String(Math.round(durationMs / 1000))}s - raise --minutes to at least ` +
      `${String(neededMinutes)}, or lower the mix send rate`,
  };
}
