import { logger } from '@wp/server-kit';
import { HEALTH_SIGNALS, WEIGHT_SUM } from './signals/registry.js';
import type { CollectCtx, CollectedEvidence } from './signals/types.js';

/**
 * score.ts (P16 Unit B, step 4) - pure health-score computation (design
 * canon: `health_score = clamp(0, 100, 100 − Σ penalty_i)`,
 * `penalty_i = weight_i × severity_i`). `computeHealthScore` is the ONE
 * function that runs every signal's `collect`, applies EWMA smoothing
 * (α=0.3) against `priorEvidence` (`instance_pacing_state.last_evidence`,
 * read/written by the CALLER - this module never touches the database
 * itself), and folds the result into `{score, evidence}`.
 *
 * SCORING RULE (binding, v1): only `scored: true` signals
 * (`registry.ts`'s `SCORED_SIGNAL_KEYS`, exactly
 * `{hard_restriction, rejected_send_rate, delivery_ratio}`) contribute a
 * non-zero `weightApplied` to the Σ. Every other signal still collects
 * evidence and appears in `evidence` with `weightApplied: 0` - never
 * silently omitted, so the evaluator/panel can show "collecting, not yet
 * scored" without a schema change later (this unit's dispatch, "v1 scoring
 * rule").
 *
 * `hard_restriction` is an OVERRIDE: when its collected `value` is `1`
 * (a restriction landed within the last 24h - see `signals/
 * hard-restriction.ts`), the returned `score` is forced to `0` regardless
 * of every other signal's severity - this is the ONE signal whose
 * `weightApplied` in the evidence JSON is reported as its severity's own
 * override contribution (`100`, "worth" the entire penalty budget) rather
 * than `weight × severity` (its `weight` is structurally `0`, see
 * `signals/hard-restriction.ts`).
 */

export interface SignalEvidence {
  readonly numerator: number | null;
  readonly denominator: number | null;
  /** Post-EWMA-smoothed value used for this tick's scoring (raw `value` for an unmeasured signal is `null`). */
  readonly value: number | null;
  readonly severity: number | null;
  readonly weightApplied: number;
  readonly unmeasured: boolean;
}

export type ScoreEvidence = Record<string, SignalEvidence>;

export interface HealthScoreResult {
  readonly score: number;
  readonly evidence: ScoreEvidence;
}

const EWMA_ALPHA = 0.3;

/** `clamp(0, 100, ...)` - the design canon's own clamp, applied to the final score only (never to an intermediate per-signal value). */
function clampScore(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * EWMA smoothing (α=0.3) over evaluation ticks: `smoothed = α × fresh + (1
 * − α) × prior`. `prior === undefined` (no evidence recorded yet for this
 * signal) skips smoothing entirely - the FIRST tick's fresh severity is
 * used as-is, since there is no prior observation to blend against.
 */
function smoothSeverity(fresh: number, prior: number | undefined): number {
  if (prior === undefined) return fresh;
  return EWMA_ALPHA * fresh + (1 - EWMA_ALPHA) * prior;
}

/** Prior evidence shape read from `instance_pacing_state.last_evidence` - only the smoothed severity per signal key is needed as EWMA input. */
export type PriorEvidence = Readonly<Record<string, { severity: number | null }>>;

export async function computeHealthScore(
  ctx: CollectCtx,
  priorEvidence: PriorEvidence,
): Promise<HealthScoreResult> {
  const evidence: ScoreEvidence = {};
  let penaltySum = 0;
  let hardRestrictionActive = false;

  for (const signal of HEALTH_SIGNALS) {
    const collected: CollectedEvidence = await signal.collect(ctx);

    if (collected === 'unmeasured') {
      evidence[signal.key] = {
        numerator: null,
        denominator: null,
        value: null,
        severity: null,
        weightApplied: 0,
        unmeasured: true,
      };
      continue;
    }

    const freshSeverity = signal.severity(collected.value);
    const priorSeverity = priorEvidence[signal.key]?.severity ?? undefined;

    // CRITICAL 1 fix (P16 fix round): `hard_restriction` is an override
    // BOOLEAN FACT ("did a restriction land in the window?"), never a rate -
    // it must never be EWMA-smoothed against prior evidence, or a fresh
    // restriction after healthy history is diluted below the `>= 1`
    // override threshold and can never fire (0.3*1 + 0.7*0 = 0.3, forever
    // short of 1 on the very tick that matters). Branch BEFORE smoothing:
    // recorded severity is the fresh value itself, not a smoothed one.
    const isHardRestriction = signal.key === 'hard_restriction';
    const recordedSeverity = isHardRestriction
      ? freshSeverity
      : smoothSeverity(freshSeverity, priorSeverity ?? undefined);

    const weightApplied = signal.scored ? signal.weight : 0;
    if (signal.scored) {
      if (isHardRestriction) {
        if (freshSeverity >= 1) {
          hardRestrictionActive = true;
        }
      } else {
        penaltySum += weightApplied * recordedSeverity;
      }
    }

    evidence[signal.key] = {
      numerator: collected.numerator,
      denominator: collected.denominator,
      value: collected.value,
      severity: recordedSeverity,
      weightApplied,
      unmeasured: false,
    };
  }

  const score = hardRestrictionActive ? 0 : clampScore(100 - penaltySum);
  return { score, evidence };
}

/** Re-exported for callers that need to sanity-check the registry's own weight total without importing `signals/registry.ts` directly. */
export { WEIGHT_SUM };

/**
 * A minimal, fully-`unmeasured` evidence vector - every registered signal
 * key present (so the panel/pacing_events shape is never missing a key), but
 * `unmeasured: true` throughout. Used only by `computeHealthScoreSafe` below
 * when the real collect path fails outright.
 */
function buildUnavailableEvidence(): ScoreEvidence {
  const evidence: ScoreEvidence = {};
  for (const signal of HEALTH_SIGNALS) {
    evidence[signal.key] = {
      numerator: null,
      denominator: null,
      value: null,
      severity: null,
      weightApplied: 0,
      unmeasured: true,
    };
  }
  return evidence;
}

/**
 * Fail-safe wrapper (P16 fix round, Fix 1): a hard-signal pause must commit
 * even when the underlying window read fails (timeout, dropped grant, lock
 * contention - core invariant 2, the pause wins over its own evidence
 * enrichment). On failure, logs ids only and returns `score: 0` (the most
 * conservative reading - a pause is already the caller's own decision here,
 * never loosened by a missing score) with a fully-`unmeasured` evidence
 * vector, never aborting the caller's transaction.
 */
export async function computeHealthScoreSafe(
  ctx: CollectCtx,
  priorEvidence: PriorEvidence,
): Promise<HealthScoreResult> {
  try {
    return await computeHealthScore(ctx, priorEvidence);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { instance_id: ctx.instanceId, client_id: ctx.clientId },
      `computeHealthScore: signal collection failed, degrading to unmeasured evidence: ${message}`,
    );
    return { score: 0, evidence: buildUnavailableEvidence() };
  }
}
