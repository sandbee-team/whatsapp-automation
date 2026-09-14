/**
 * capacity/trimmed-mean.ts (P10, FIX-P10-A finding 12) - the ONE canonical
 * trimmed-mean helper (ADR 0018 S3 makes the 24h trimmed mean canon), used by
 * both the production feedback loop (`engine/fleet/session-cost-feedback.ts`)
 * and the ramp-measurement soak averaging (`scripts/measure/ramp-sessions.ts`).
 * Before this fix the two call sites had independently reinvented this with
 * slightly different trim fractions and empty/degenerate-set behavior - one
 * pure implementation, shared, removes that drift risk.
 *
 * Pure and deterministic: no Node builtins, no clock, no I/O - runs unchanged
 * in a browser per this package's own module doc.
 *
 * Behavior (documented explicitly, since this is exactly where the two prior
 * impls diverged):
 *   - Empty input (`values.length === 0`) returns `0`. Never throws, never
 *     NaN - callers that can hit this case (e.g. a soak window with zero
 *     samples) get a defined, safe zero rather than a crash.
 *   - Sorts ascending, then drops `Math.floor(n / 10)` values from EACH end
 *     (a 10% trim per side - matches the fleet feedback loop's own documented
 *     decile drop, e.g. exactly 1 min/max sample dropped from a 10-worker
 *     set).
 *   - If the trim would remove every value (trimmed set ends up empty, e.g.
 *     `n` too small for `2 * trimCount` to leave anything), falls back to the
 *     UNTRIMMED sorted set rather than averaging nothing.
 *   - Otherwise returns the arithmetic mean of the trimmed set.
 */
export function trimmedMean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const trimCount = Math.floor(n / 10);
  const trimmed =
    trimCount > 0 && n - 2 * trimCount > 0 ? sorted.slice(trimCount, n - trimCount) : sorted;

  return trimmed.reduce((sum, v) => sum + v, 0) / trimmed.length;
}
