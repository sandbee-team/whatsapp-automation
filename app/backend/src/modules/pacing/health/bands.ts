/**
 * bands.ts (P16 Unit B, step 5) - pure band decision (design §3.2). NO DB
 * access, NO `Date.now()` - every timestamp is a caller-supplied `*Ms`
 * epoch-millis number, so this module is deterministic and unit-testable
 * with a fake clock.
 *
 * BANDS: HEALTHY >=70, WATCH 55-69, DEGRADED 35-54, CRITICAL <35.
 *
 * TIGHTENING: applied on the FIRST evaluation tick that crosses a lower
 * threshold - no dwell requirement in the downward direction.
 *
 * LOOSENING requires ALL of: (a) hysteresis - score >= entry+8 (WATCH->
 * HEALTHY needs 78, DEGRADED->WATCH needs 63); (b) dwell - score has stayed
 * above that hysteresis line for the FULL dwell window (2h WATCH->HEALTHY,
 * 6h DEGRADED->WATCH), tracked here via `bandSinceMs` (the caller's own
 * "how long has THIS band been current" timestamp - this module treats it
 * as "how long has the score already satisfied the hysteresis condition"
 * per the dispatch's exact wording, since the caller only re-evaluates a
 * loosening decision once band-tenure has already begun); (c) no hard
 * restriction signal in the last 24h; (d) the flap-rate cap below.
 *
 * ANTI-FLAP: at most 1 band improvement per 6h AND at most 2 per 24h,
 * derived from `recentBandChanges` (the CALLER-supplied list of past
 * `pacing_events` BAND_CHANGE rows) - NEVER a counter column. If the
 * instance already changed band TWICE in the last hour, a third change
 * applies ONLY in the tightening direction; a would-be loosening is
 * DEFERRED and reported via `suppressedByFlap: true` so the caller can
 * write a `BAND_CHANGE_SUPPRESSED` pacing_events row and bump the flap
 * metric, per this unit's dispatch.
 */

export type HealthBand = 'healthy' | 'watch' | 'degraded' | 'critical';

export interface BandChangeRecord {
  readonly atMs: number;
  readonly from: HealthBand;
  readonly to: HealthBand;
}

export interface DecideBandInput {
  readonly currentBand: HealthBand;
  readonly score: number;
  readonly nowMs: number;
  /** How long the score has already satisfied a loosening's hysteresis condition, if applicable - see this file's own header. */
  readonly bandSinceMs: number;
  readonly lastHardSignalAtMs: number | null;
  readonly recentBandChanges: readonly BandChangeRecord[];
}

export type BandDirection = 'tighten' | 'loosen' | 'none';

export interface DecideBandResult {
  readonly band: HealthBand;
  readonly changed: boolean;
  readonly direction: BandDirection;
  readonly suppressedByFlap?: boolean;
  readonly reason: string;
}

const BAND_ORDER: readonly HealthBand[] = ['critical', 'degraded', 'watch', 'healthy'];

function rank(band: HealthBand): number {
  return BAND_ORDER.indexOf(band);
}

function bandForScore(score: number): HealthBand {
  if (score >= 70) return 'healthy';
  if (score >= 55) return 'watch';
  if (score >= 35) return 'degraded';
  return 'critical';
}

const HYSTERESIS_MARGIN = 8;
const DWELL_MS: Partial<Record<HealthBand, number>> = {
  // Keyed by the band being ENTERED (the target of a loosening move).
  healthy: 2 * 60 * 60 * 1000,
  watch: 6 * 60 * 60 * 1000,
};
const HARD_SIGNAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const MAX_IMPROVEMENTS_PER_6H = 1;
const MAX_IMPROVEMENTS_PER_24H = 2;
const MAX_IMPROVEMENTS_PER_1H_BEFORE_FLAP_LOCK = 2;

function entryScoreFor(target: HealthBand): number {
  // The score threshold the band's OWN tightening entry uses (bandForScore's
  // own boundaries) - hysteresis adds HYSTERESIS_MARGIN on top of this.
  if (target === 'healthy') return 70;
  if (target === 'watch') return 55;
  if (target === 'degraded') return 35;
  return 0;
}

function countImprovementsSince(
  recentBandChanges: readonly BandChangeRecord[],
  nowMs: number,
  windowMs: number,
): number {
  return recentBandChanges.filter(
    (change) => nowMs - change.atMs <= windowMs && rank(change.to) > rank(change.from),
  ).length;
}

/**
 * WARNING 4 fix (P16 fix round): the flap lock (`MAX_IMPROVEMENTS_PER_1H_
 * BEFORE_FLAP_LOCK`, applied to the LOOSENING direction only) must count
 * every band change in the window, not just improvements - a
 * tighten-tighten-then-loosen sequence inside an hour is exactly as flappy
 * as a loosen-loosen-then-loosen one, and the ONLY signal a fresh loosening
 * decision has of that recent instability is `recentBandChanges` itself
 * (never a counter column, module doc). The two ANTI-FLAP budgets
 * (`MAX_IMPROVEMENTS_PER_6H`/`_24H`) stay improvement-scoped -
 * `countImprovementsSince` above is unchanged for those two call sites.
 */
function countChangesSince(
  recentBandChanges: readonly BandChangeRecord[],
  nowMs: number,
  windowMs: number,
): number {
  return recentBandChanges.filter((change) => nowMs - change.atMs <= windowMs).length;
}

function hasHardSignalWithin24h(lastHardSignalAtMs: number | null, nowMs: number): boolean {
  return lastHardSignalAtMs !== null && nowMs - lastHardSignalAtMs <= HARD_SIGNAL_LOOKBACK_MS;
}

/** Every gate a loosening move must clear, beyond the raw score band shift itself. */
function loosingAllowed(input: DecideBandInput, targetBand: HealthBand): boolean {
  const hysteresisFloor = entryScoreFor(targetBand) + HYSTERESIS_MARGIN;
  if (input.score < hysteresisFloor) return false;

  const dwellRequiredMs = DWELL_MS[targetBand] ?? 0;
  if (input.nowMs - input.bandSinceMs < dwellRequiredMs) return false;

  if (hasHardSignalWithin24h(input.lastHardSignalAtMs, input.nowMs)) return false;

  const improvements6h = countImprovementsSince(input.recentBandChanges, input.nowMs, SIX_HOURS_MS);
  if (improvements6h >= MAX_IMPROVEMENTS_PER_6H) return false;

  const improvements24h = countImprovementsSince(
    input.recentBandChanges,
    input.nowMs,
    TWENTY_FOUR_HOURS_MS,
  );
  if (improvements24h >= MAX_IMPROVEMENTS_PER_24H) return false;

  return true;
}

export function decideBand(input: DecideBandInput): DecideBandResult {
  const targetBand = bandForScore(input.score);

  if (targetBand === input.currentBand) {
    return { band: input.currentBand, changed: false, direction: 'none', reason: 'no_crossing' };
  }

  const isTightening = rank(targetBand) < rank(input.currentBand);

  if (isTightening) {
    // Tightening applies on the FIRST crossing tick - no dwell, no
    // hysteresis, no flap cap (the anti-flap rule only bounds IMPROVEMENTS).
    return {
      band: targetBand,
      changed: true,
      direction: 'tighten',
      reason: 'threshold_crossed_down',
    };
  }

  // Loosening direction. Flap lock counts ANY change (tighten or loosen) in
  // the last hour, not only improvements - see countChangesSince's own doc.
  const changesInLastHour = countChangesSince(input.recentBandChanges, input.nowMs, ONE_HOUR_MS);
  if (changesInLastHour >= MAX_IMPROVEMENTS_PER_1H_BEFORE_FLAP_LOCK) {
    return {
      band: input.currentBand,
      changed: false,
      direction: 'none',
      suppressedByFlap: true,
      reason: 'flap_lock_1h',
    };
  }

  if (!loosingAllowed(input, targetBand)) {
    return {
      band: input.currentBand,
      changed: false,
      direction: 'none',
      reason: 'loosening_gate_not_satisfied',
    };
  }

  return {
    band: targetBand,
    changed: true,
    direction: 'loosen',
    reason: 'hysteresis_dwell_satisfied',
  };
}
