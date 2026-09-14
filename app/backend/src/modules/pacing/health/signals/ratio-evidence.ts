import type { CollectedEvidence } from './types.js';

/**
 * signals/ratio-evidence.ts (P16 Unit B, step 3) - the shared
 * "numerator/denominator -> CollectedEvidence" honesty gate every ratio-
 * shaped collector applies: below `minEvidence` (measured against the
 * DENOMINATOR - the "how many opportunities did we have to observe this"
 * count, per the canonical table's own "min evidence" column) or a
 * zero/empty denominator, the collector returns `'unmeasured'`, NEVER a
 * computed `0` - see `types.ts`'s own header ("a collector whose source is
 * empty returns `'unmeasured'`, NEVER 0").
 */
export function ratioEvidence(
  numerator: number,
  denominator: number,
  minEvidence: number,
): CollectedEvidence {
  if (denominator <= 0 || denominator < minEvidence) {
    return 'unmeasured';
  }
  return { numerator, denominator, value: numerator / denominator };
}

/**
 * The "per 1,000 sent" shaped signals (`recipient_block_indicator`,
 * `opt_out_rate`) - same min-evidence gate as `ratioEvidence`, but `value`
 * is a rate-per-1000, not a plain ratio, and the min-evidence bar is
 * measured against `sentCount` (the volume denominator), not the raw
 * numerator.
 */
export function perThousandEvidence(
  numerator: number,
  sentCount: number,
  minEvidence: number,
): CollectedEvidence {
  if (sentCount <= 0 || sentCount < minEvidence) {
    return 'unmeasured';
  }
  return { numerator, denominator: sentCount, value: (numerator / sentCount) * 1000 };
}
