/**
 * The six-tier `safe_default` warm-up ladder, and the health-band
 * multiplier/override table, as DATA (P13 Unit U2, blueprint § warm-up
 * ramp + § Signal-driven health).
 *
 * DERIVED, not measured: every number in `WARMUP_LADDER` and
 * `HEALTH_BAND_EFFECTS` below is a starting judgement call, to be revisited
 * from real `pacing_events` evidence after live traffic - same caveat as
 * `db/migrations/0031_pacing_seed.sql`'s header, which this table mirrors
 * exactly (row-for-row, column-for-column) for the `safe_default` profile.
 *
 * This module is DATA, not the runtime authority: the database
 * (`instance_pacing_state.eff_*`) is what the reserve statement actually
 * reads in-statement. This module exists so `resolveEffective()`
 * (`resolve-effective.ts`) can fold the warm-up-tier layer PURELY, without
 * a DB round trip, in a browser-safe/deterministic way. The two copies
 * (this file and migration 0031) must be kept in agreement by hand - see
 * that migration's header, which points back at this file by name.
 */

/** One row of the six-tier `safe_default` warm-up ladder. */
export interface WarmupTier {
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  /** Instance-age day range this tier applies to (`dayTo: null` = open-ended, tier 6). */
  dayFrom: number;
  dayTo: number | null;
  dailyCap: number;
  hourlyCap: number;
  newConvCap: number;
  gapMinMs: number;
  gapMaxMs: number;
  coldRatioMax: number;
  groupDailyCap: number;
  blockLinkFirst: boolean;
  blockGroupActions: boolean;
}

/**
 * The `safe_default` ladder, verbatim from migration 0031's seeded rows
 * (see that file's table comment for the full per-tier rationale).
 */
export const WARMUP_LADDER: readonly WarmupTier[] = Object.freeze([
  Object.freeze({
    tier: 1,
    dayFrom: 1,
    dayTo: 2,
    dailyCap: 20,
    hourlyCap: 6,
    newConvCap: 8,
    gapMinMs: 45_000,
    gapMaxMs: 180_000,
    coldRatioMax: 0.4,
    groupDailyCap: 0,
    blockLinkFirst: true,
    blockGroupActions: true,
  }),
  Object.freeze({
    tier: 2,
    dayFrom: 3,
    dayTo: 7,
    dailyCap: 50,
    hourlyCap: 12,
    newConvCap: 15,
    gapMinMs: 40_000,
    gapMaxMs: 150_000,
    coldRatioMax: 0.5,
    groupDailyCap: 0,
    blockLinkFirst: true,
    blockGroupActions: true,
  }),
  Object.freeze({
    tier: 3,
    dayFrom: 8,
    dayTo: 14,
    dailyCap: 150,
    hourlyCap: 25,
    newConvCap: 40,
    gapMinMs: 30_000,
    gapMaxMs: 120_000,
    coldRatioMax: 0.6,
    groupDailyCap: 0,
    blockLinkFirst: true,
    blockGroupActions: true,
  }),
  Object.freeze({
    tier: 4,
    dayFrom: 15,
    dayTo: 21,
    dailyCap: 300,
    hourlyCap: 45,
    newConvCap: 80,
    gapMinMs: 25_000,
    gapMaxMs: 90_000,
    coldRatioMax: 0.7,
    groupDailyCap: 10,
    blockLinkFirst: false,
    blockGroupActions: false,
  }),
  Object.freeze({
    tier: 5,
    dayFrom: 22,
    dayTo: 29,
    dailyCap: 450,
    hourlyCap: 60,
    newConvCap: 110,
    gapMinMs: 20_000,
    gapMaxMs: 75_000,
    coldRatioMax: 0.75,
    groupDailyCap: 20,
    blockLinkFirst: false,
    blockGroupActions: false,
  }),
  Object.freeze({
    tier: 6,
    dayFrom: 30,
    dayTo: null,
    dailyCap: 600,
    hourlyCap: 80,
    newConvCap: 150,
    gapMinMs: 15_000,
    gapMaxMs: 60_000,
    coldRatioMax: 0.8,
    groupDailyCap: 30,
    blockLinkFirst: false,
    blockGroupActions: false,
  }),
]);

/** The four signal-driven health bands (blueprint § Signal-driven health). */
export type HealthBand = 'healthy' | 'watch' | 'degraded' | 'critical';

/**
 * Per-band multipliers/overrides applied on top of the resolved warm-up
 * layer. `critical` is represented here for completeness only - actually
 * pausing sends on `critical` is P16's concern, not resolved by this
 * package (`resolveEffective()` folds the multipliers below; it does not
 * decide whether to pause).
 */
export interface HealthBandEffect {
  capMultiplier: number;
  gapMultiplier: number;
  /** Multiplier on `newConvCap` specifically (tighter than the general cap multiplier on `watch`/`degraded`). */
  newConvMultiplier: number;
  /** `true` freezes warm-up tier advancement while this band is active (P13a's concern to enforce; represented here). */
  freezesWarmup: boolean;
  /** Multiplier on `groupDailyCap` (scope delta § Groups: `watch` halves it, `degraded`/`critical` zero it). */
  groupCapMultiplier: number;
  /** `true` means this band pauses the instance entirely (P16's concern to enforce; represented here). */
  paused: boolean;
}

export const HEALTH_BAND_EFFECTS: Readonly<Record<HealthBand, HealthBandEffect>> = Object.freeze({
  healthy: Object.freeze({
    capMultiplier: 1.0,
    gapMultiplier: 1.0,
    newConvMultiplier: 1.0,
    freezesWarmup: false,
    groupCapMultiplier: 1.0,
    paused: false,
  }),
  watch: Object.freeze({
    capMultiplier: 0.7,
    gapMultiplier: 1.5,
    newConvMultiplier: 0.5,
    freezesWarmup: true,
    groupCapMultiplier: 0.5,
    paused: false,
  }),
  degraded: Object.freeze({
    capMultiplier: 0.4,
    gapMultiplier: 2.5,
    newConvMultiplier: 0,
    freezesWarmup: true,
    groupCapMultiplier: 0,
    paused: false,
  }),
  critical: Object.freeze({
    capMultiplier: 0,
    gapMultiplier: 1.0,
    newConvMultiplier: 0,
    freezesWarmup: true,
    groupCapMultiplier: 0,
    paused: true,
  }),
});
