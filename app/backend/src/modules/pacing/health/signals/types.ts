import type { TenantQueryable } from '@wp/db';

/**
 * signals/types.ts (P16 Unit B, step 2) - the shared contract every one of
 * the twelve health signals implements (design canon `.claude/skills/
 * wp-architecture` health-score model, blueprint [R-27s]). A `Signal`
 * COLLECTS raw evidence (`collect`) and separately turns a collected value
 * into a `severity` in `[0,1]` (`severity`) - the two are split so `score.ts`
 * can apply the SAME min-evidence-gate / EWMA / weighting logic uniformly
 * over all twelve without any signal-specific branching, and so a collector
 * can be unit-tested against a stubbed `sql` without touching the
 * piecewise-linear math at all.
 *
 * `scored` is a per-signal LITERAL flag, not inferred from `weight > 0` -
 * v1 deliberately gives all twelve a non-zero-shaped `weight` in the
 * registry (matching the canonical table) but only THREE actually multiply
 * their severity into the score (`registry.ts`'s own header explains why:
 * `scored: false` signals still collect evidence and appear in the score
 * evidence JSON with `weightApplied: 0`, so the panel/evaluator can show
 * "collecting, not yet scored" without a schema change later).
 *
 * NO `Date.now()` anywhere in a signal or its collector - `CollectCtx.now`
 * is always caller-injected (fake-clock-driven in every test), matching the
 * "no sleeps, no live-clock assertions" test-discipline rule.
 */

/** The rolling/fixed window a signal's SQL predicate reads over - documentation only here; the actual boundary math lives in `db/queries/health-signal-windows.sql`. */
export type SignalWindow = '6h' | '1h' | '24h' | '72h' | 'event';

/** Minimal query surface a collector needs - deliberately just `TenantQueryable` (already tenant-scoped by the caller's transaction), never a bare pool. */
export type CollectCtx = {
  readonly sql: TenantQueryable;
  readonly instanceId: string;
  readonly clientId: string;
  /** Caller-injected clock - collectors/signals never call `Date.now()`/`new Date()` themselves. */
  readonly now: () => Date;
};

/** A collected evidence point: a numerator/denominator ratio pair plus the resolved `value` the signal's own `severity()` consumes. `'unmeasured'` (never `0`) when the source is empty or below `minEvidence` - see this file's own header and `registry.ts`'s honesty-rule note. */
export type CollectedEvidence =
  | {
      readonly numerator: number;
      readonly denominator: number;
      readonly value: number;
    }
  | 'unmeasured';

export interface Signal {
  readonly key: string;
  readonly window: SignalWindow;
  /** Canonical table weight (design §3.1). Present even for `scored: false` signals - see this file's own header. `hard_restriction` carries `weight: 0` and is excluded from `WEIGHT_SUM` by `registry.ts`'s own filter (an override, not a weighted signal). */
  readonly weight: number;
  readonly minEvidence: number;
  /** Exactly `true` for `{hard_restriction, rejected_send_rate, delivery_ratio}` in v1 - see `registry.ts`. */
  readonly scored: boolean;
  collect(ctx: CollectCtx): CollectedEvidence | Promise<CollectedEvidence>;
  /** Piecewise-linear `[0,1]` severity for an already-collected `value` (ratio/count, per the canonical table's own units). Not called at all when `collect` returned `'unmeasured'`. */
  severity(value: number): number;
}

/**
 * Shared piecewise-linear helper (design §3.1: "severity ∈ [0,1] piecewise-
 * linear between `good` (severity 0) and `bad` (severity 1) thresholds").
 * Handles BOTH directions - `good < bad` (higher-is-worse, e.g. a failure
 * rate) and `good > bad` (lower-is-worse, e.g. a delivery ratio) - by
 * normalizing along the `good -> bad` axis regardless of which one is
 * numerically larger. Clamped to `[0,1]` at both ends: a value at or beyond
 * `bad` (in the worsening direction) is severity `1`; a value at or better
 * than `good` is severity `0`.
 */
export function piecewiseLinearSeverity(value: number, good: number, bad: number): number {
  if (good === bad) {
    // Degenerate threshold pair (canon table never defines one, but a
    // registry typo could) - fail toward the worse reading rather than
    // divide by zero.
    return value === good ? 0 : 1;
  }
  const fraction = (value - good) / (bad - good);
  if (fraction <= 0) return 0;
  if (fraction >= 1) return 1;
  return fraction;
}
