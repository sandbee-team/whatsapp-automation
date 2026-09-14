import {
  ABSOLUTE_DAILY_CEILING,
  ABSOLUTE_GAP_MIN_MS,
  ABSOLUTE_GROUP_DAILY_CEILING,
} from './constants.js';
import { HEALTH_BAND_EFFECTS, type HealthBand } from './warmup-ladder.js';

/**
 * `resolveEffective()` - the pure fold that computes the resolved (`eff_*`)
 * pacing limits (P13 Unit U2, safe-mode design §4.1, verbatim resolution
 * order):
 *
 *   effective = STRICTEST_OF(
 *       system_profile(profile_key),        # platform-owned, read-only
 *       warmup_tier_limits(tier),            # time-based ramp
 *       health_band_multipliers(band),       # signal-driven tightening
 *       tenant_tightening(instance),         # tenant may only tighten
 *   ) THEN apply admin_override(instance)    # explicit, reasoned, audited
 *
 * "Strictest" is per-field: `Math.min` on every cap, `Math.max` on every
 * gap (a LONGER gap is stricter), narrowest window wins (intersect start/
 * end), and `true` wins on either boolean block flag. `admin_override` is
 * the one layer allowed to LOOSEN a value - applied last, then clamped by
 * the absolute constants in `constants.ts` (the true last word; even an
 * admin override cannot cross them - core invariant 6).
 *
 * Output keys map 1:1 onto `instance_pacing_state`'s materialised `eff_*`
 * columns (U1, migration 0030) via this exact camelCase<->snake_case
 * mapping (U4's config service performs the `UPDATE`, this module never
 * touches the DB):
 *   dailyCap          -> eff_daily_cap
 *   hourlyCap         -> eff_hourly_cap
 *   newConvCap        -> eff_new_conv_cap
 *   gapMinMs          -> eff_gap_min_ms
 *   gapMaxMs          -> eff_gap_max_ms
 *   coldRatioMax      -> eff_cold_ratio_max
 *   coldRatioFloor    -> eff_cold_ratio_floor
 *   windowStartLocal  -> eff_window_start_local
 *   windowEndLocal    -> eff_window_end_local
 *   groupDailyCap     -> eff_group_daily_cap
 * `perRecipient24h` has no `eff_*` column (it lives on `pacing_profiles`
 * only, per U1's schema) - it is still folded strictest-wins here because
 * the resolution order applies uniformly to every cap-shaped field, but
 * U4 does not write it back to `instance_pacing_state`.
 *
 * `engagement_exempt` is DELIBERATELY not a field of `Layers` at all (see
 * the block comment above `Layers` below) - it must be structurally
 * incapable of reaching this fold.
 */

/** A local time-of-day window, "HH:MM" 24-hour, matching Postgres `time`. */
export interface LocalWindow {
  startLocal: string;
  endLocal: string;
}

/**
 * One layer's contribution to the fold. Every field is optional: a layer
 * that does not constrain a given field (e.g. a tenant patch that only
 * tightens `dailyCap`) omits it, and the fold simply does not apply that
 * layer's (non-)opinion to that field.
 *
 * NOTE: there is deliberately NO `engagementExempt` field here, anywhere in
 * `Layers`, or on `AdminOverride`. The blueprint requires the flag to live
 * "in a type the pacing gate cannot import" - honoured structurally by
 * simply never declaring it in this module's input surface. It affects
 * only the displayed deny-reason copy and the warm-up-freeze decision
 * (P13a's concern), never a cap and never the cold-ratio gate.
 * `assertNoEngagementExemptLeak()` below gives callers a way to prove a
 * layer object carrying a stray `engagementExempt` key still yields a
 * byte-identical result (see `resolve-effective.test.ts`).
 */
export interface PacingLayer {
  dailyCap?: number;
  hourlyCap?: number;
  newConvCap?: number;
  gapMinMs?: number;
  gapMaxMs?: number;
  coldRatioMax?: number;
  coldRatioFloor?: number;
  perRecipient24h?: number;
  groupDailyCap?: number;
  window?: LocalWindow;
  blockLinkFirst?: boolean;
  blockGroupActions?: boolean;
}

/**
 * Explicit, reasoned, audited admin relax/tighten (design §4.1: the one
 * layer allowed to LOOSEN a value). Carries the audit fields the blueprint
 * requires even though this pure module does not persist them.
 */
export interface AdminOverride extends PacingLayer {
  actorUserId: string;
  reason: string;
  /** ms epoch; `resolveEffective()` does not read the clock, so expiry is the caller's concern (inject a resolved boolean instead if needed). */
  expiresAt: number | null;
}

export interface Layers {
  systemProfile: PacingLayer;
  warmupTier: PacingLayer;
  healthBand: HealthBand;
  tenantTightening?: PacingLayer;
  adminOverride?: AdminOverride;
}

/** The resolved, `eff_*`-shaped output (camelCase; see module doc for the DB mapping). */
export interface EffectiveLimits {
  dailyCap: number;
  hourlyCap: number;
  newConvCap: number;
  gapMinMs: number;
  gapMaxMs: number;
  coldRatioMax: number;
  coldRatioFloor: number;
  perRecipient24h?: number;
  groupDailyCap: number;
  windowStartLocal?: string;
  windowEndLocal?: string;
  blockLinkFirst: boolean;
  blockGroupActions: boolean;
}

function minOf(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length === 0 ? undefined : Math.min(...defined);
}

function maxOf(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length === 0 ? undefined : Math.max(...defined);
}

function orFalse(...values: Array<boolean | undefined>): boolean {
  return values.some((v) => v === true);
}

/** Narrowest-window intersection: the latest start, the earliest end. */
function intersectWindow(...windows: Array<LocalWindow | undefined>): LocalWindow | undefined {
  const [first, ...rest] = windows.filter((w): w is LocalWindow => w !== undefined);
  if (first === undefined) return undefined;
  let start = first.startLocal;
  let end = first.endLocal;
  for (const w of rest) {
    if (w.startLocal > start) start = w.startLocal;
    if (w.endLocal < end) end = w.endLocal;
  }
  return { startLocal: start, endLocal: end };
}

function applyHealthBandCaps(layer: PacingLayer, band: HealthBand): PacingLayer {
  const effect = HEALTH_BAND_EFFECTS[band];
  const result: PacingLayer = { ...layer };
  if (layer.dailyCap !== undefined) result.dailyCap = layer.dailyCap * effect.capMultiplier;
  if (layer.hourlyCap !== undefined) result.hourlyCap = layer.hourlyCap * effect.capMultiplier;
  if (layer.newConvCap !== undefined) {
    result.newConvCap = layer.newConvCap * effect.newConvMultiplier;
  }
  if (layer.gapMinMs !== undefined) result.gapMinMs = layer.gapMinMs * effect.gapMultiplier;
  if (layer.gapMaxMs !== undefined) result.gapMaxMs = layer.gapMaxMs * effect.gapMultiplier;
  if (layer.groupDailyCap !== undefined) {
    result.groupDailyCap = layer.groupDailyCap * effect.groupCapMultiplier;
  }
  return result;
}

function foldStrictest(layers: readonly PacingLayer[]): PacingLayer {
  return {
    dailyCap: minOf(...layers.map((l) => l.dailyCap)),
    hourlyCap: minOf(...layers.map((l) => l.hourlyCap)),
    newConvCap: minOf(...layers.map((l) => l.newConvCap)),
    gapMinMs: maxOf(...layers.map((l) => l.gapMinMs)),
    gapMaxMs: maxOf(...layers.map((l) => l.gapMaxMs)),
    coldRatioMax: minOf(...layers.map((l) => l.coldRatioMax)),
    coldRatioFloor: maxOf(...layers.map((l) => l.coldRatioFloor)),
    perRecipient24h: minOf(...layers.map((l) => l.perRecipient24h)),
    groupDailyCap: minOf(...layers.map((l) => l.groupDailyCap)),
    window: intersectWindow(...layers.map((l) => l.window)),
    blockLinkFirst: orFalse(...layers.map((l) => l.blockLinkFirst)),
    blockGroupActions: orFalse(...layers.map((l) => l.blockGroupActions)),
  };
}

/** Applies `admin_override` last: any field it sets REPLACES the folded value outright (it is the one layer allowed to loosen). */
function applyAdminOverride(folded: PacingLayer, override: AdminOverride | undefined): PacingLayer {
  if (!override) return folded;
  return {
    dailyCap: override.dailyCap ?? folded.dailyCap,
    hourlyCap: override.hourlyCap ?? folded.hourlyCap,
    newConvCap: override.newConvCap ?? folded.newConvCap,
    gapMinMs: override.gapMinMs ?? folded.gapMinMs,
    gapMaxMs: override.gapMaxMs ?? folded.gapMaxMs,
    coldRatioMax: override.coldRatioMax ?? folded.coldRatioMax,
    coldRatioFloor: override.coldRatioFloor ?? folded.coldRatioFloor,
    perRecipient24h: override.perRecipient24h ?? folded.perRecipient24h,
    groupDailyCap: override.groupDailyCap ?? folded.groupDailyCap,
    window: override.window ?? folded.window,
    blockLinkFirst: override.blockLinkFirst ?? folded.blockLinkFirst,
    blockGroupActions: override.blockGroupActions ?? folded.blockGroupActions,
  };
}

/**
 * The two structural invariants (design §4.1), enforced here as the final
 * clamp - the true last word, applied AFTER `admin_override`:
 *   - `gapMinMs`/`gapMaxMs` never below `ABSOLUTE_GAP_MIN_MS`.
 *   - `dailyCap` never above `ABSOLUTE_DAILY_CEILING`.
 *   - `groupDailyCap` never above `ABSOLUTE_GROUP_DAILY_CEILING`, even for
 *     an admin relax (scope delta § Groups - no exception path).
 */
function clampToAbsolutes(layer: PacingLayer): PacingLayer {
  return {
    ...layer,
    dailyCap:
      layer.dailyCap === undefined ? undefined : Math.min(layer.dailyCap, ABSOLUTE_DAILY_CEILING),
    gapMinMs:
      layer.gapMinMs === undefined ? undefined : Math.max(layer.gapMinMs, ABSOLUTE_GAP_MIN_MS),
    gapMaxMs:
      layer.gapMaxMs === undefined ? undefined : Math.max(layer.gapMaxMs, ABSOLUTE_GAP_MIN_MS),
    groupDailyCap:
      layer.groupDailyCap === undefined
        ? undefined
        : Math.min(layer.groupDailyCap, ABSOLUTE_GROUP_DAILY_CEILING),
  };
}

/**
 * Resolves the four-layer fold into the final `EffectiveLimits`. Every cap/
 * gap/window field that ends up `undefined` after folding (no layer ever
 * set it) throws - a real caller (U4) always supplies at minimum the
 * system profile and warm-up tier, so an all-`undefined` field indicates a
 * caller bug, not a legitimate "no opinion" outcome for a required field.
 */
export function resolveEffective(layers: Layers): EffectiveLimits {
  const bandAdjusted = [
    applyHealthBandCaps(layers.systemProfile, layers.healthBand),
    applyHealthBandCaps(layers.warmupTier, layers.healthBand),
    ...(layers.tenantTightening
      ? [applyHealthBandCaps(layers.tenantTightening, layers.healthBand)]
      : []),
  ];
  const folded = foldStrictest(bandAdjusted);
  const overridden = applyAdminOverride(folded, layers.adminOverride);
  const clamped = clampToAbsolutes(overridden);

  return {
    dailyCap: requireNumber(clamped.dailyCap, 'dailyCap'),
    hourlyCap: requireNumber(clamped.hourlyCap, 'hourlyCap'),
    newConvCap: requireNumber(clamped.newConvCap, 'newConvCap'),
    gapMinMs: requireNumber(clamped.gapMinMs, 'gapMinMs'),
    gapMaxMs: requireNumber(clamped.gapMaxMs, 'gapMaxMs'),
    coldRatioMax: requireNumber(clamped.coldRatioMax, 'coldRatioMax'),
    coldRatioFloor: requireNumber(clamped.coldRatioFloor, 'coldRatioFloor'),
    perRecipient24h: clamped.perRecipient24h,
    groupDailyCap: clamped.groupDailyCap ?? 0,
    windowStartLocal: clamped.window?.startLocal,
    windowEndLocal: clamped.window?.endLocal,
    blockLinkFirst: clamped.blockLinkFirst ?? false,
    blockGroupActions: clamped.blockGroupActions ?? false,
  };
}

function requireNumber(value: number | undefined, field: string): number {
  if (value === undefined) {
    throw new RangeError(
      `resolveEffective: no layer supplied a value for required field "${field}"`,
    );
  }
  return value;
}
