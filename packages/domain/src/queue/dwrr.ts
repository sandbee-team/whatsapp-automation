/**
 * Deficit-weighted round robin over the priority bands (blueprint "Fair
 * scheduling": `HIGH:NORMAL:LOW = 6:3:1`, falling through to the next
 * non-empty band; deficit state is per-worker, in-memory, rebuildable on
 * lease acquisition [R-39]). Priority orders eligible jobs; it is never an
 * absolute priority - a continuous HIGH stream must not starve NORMAL/LOW.
 *
 * Pure and deterministic: no `Date`, no `Math.random`, no I/O. All state is
 * internal to the object `createDwrrSelector` returns.
 */

export type Band = 'HIGH' | 'NORMAL' | 'LOW';

export const DEFAULT_BAND_WEIGHTS: Readonly<Record<Band, number>> = Object.freeze({
  HIGH: 6,
  NORMAL: 3,
  LOW: 1,
});

const BAND_ORDER: readonly Band[] = ['HIGH', 'NORMAL', 'LOW'];

export interface DwrrSelector {
  /**
   * Selects the next band to serve one job from, given which bands
   * currently have an eligible job. Returns `null` only when no band has
   * anything available (state is left untouched in that case).
   */
  next(available: Record<Band, boolean>): Band | null;
}

/**
 * Weights are integer credit units by design (deficit-weighted round robin
 * accrues a whole-number deficit per visit) - anything that is not a
 * positive integer >= 1 can never accrue enough deficit to reach the >= 1
 * selection threshold on its own (0), goes backwards forever (negative), or
 * has no well-defined credit-unit meaning (fractional). Reject all three at
 * construction rather than accepting a band that can silently never be
 * selected.
 */
function assertValidWeights(weights: Readonly<Record<Band, number>>): void {
  for (const band of BAND_ORDER) {
    const weight = weights[band];
    if (!Number.isInteger(weight) || weight < 1) {
      throw new RangeError(
        `createDwrrSelector: weight for band "${band}" must be a positive integer >= 1, got ${String(weight)}`,
      );
    }
  }
}

export function createDwrrSelector(
  weights: Readonly<Record<Band, number>> = DEFAULT_BAND_WEIGHTS,
): DwrrSelector {
  assertValidWeights(weights);

  const deficits: Record<Band, number> = { HIGH: 0, NORMAL: 0, LOW: 0 };
  let cursor = 0;

  return {
    next(available: Record<Band, boolean>): Band | null {
      if (!available.HIGH && !available.NORMAL && !available.LOW) {
        return null;
      }

      // Bounded: at least one band is available and every weight is >= 1,
      // so within one full pass of the band order that band's deficit will
      // reach >= 1 on its own visit and get selected.
      for (let guard = 0; guard < BAND_ORDER.length; guard += 1) {
        const band = BAND_ORDER[cursor] as Band;

        if (!available[band]) {
          // Empty band: drop its accrued deficit and fall through to the
          // next non-empty band, per the blueprint's "falling through"
          // rule.
          deficits[band] = 0;
          cursor = (cursor + 1) % BAND_ORDER.length;
          continue;
        }

        if (deficits[band] < 1) {
          deficits[band] += weights[band];
        }

        if (deficits[band] >= 1) {
          deficits[band] -= 1;
          if (deficits[band] < 1) {
            // Deficit exhausted - move on to the next band next time.
            cursor = (cursor + 1) % BAND_ORDER.length;
          }
          return band;
        }

        cursor = (cursor + 1) % BAND_ORDER.length;
      }

      // Unreachable given the guard above, but keeps the function total.
      return null;
    },
  };
}
