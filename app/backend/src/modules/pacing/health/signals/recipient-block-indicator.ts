import type { CollectedEvidence, Signal } from './types.js';
import { piecewiseLinearSeverity } from './types.js';

/**
 * signals/recipient-block-indicator.ts (P16 Unit B, step 3) - count per
 * 1,000 sent. Design table: weight 10, good<=1, bad>=15, min evidence 100
 * sends. NO v1 source (dispatch's explicit instruction): no block-signal
 * table exists yet in this schema (checked migrations 0001-0044), so this
 * collector ALWAYS returns `'unmeasured'` regardless of send volume - never
 * a computed `0`, since "zero block signals" cannot be distinguished from
 * "we have no way to observe a block signal at all" without a real source.
 * `severity`/`weight`/`minEvidence` are kept per the canonical table for
 * when a source lands (a later phase), even though `collect` never reaches
 * them today.
 */
function collect(): CollectedEvidence {
  return 'unmeasured';
}

export const recipientBlockIndicatorSignal: Signal = {
  key: 'recipient_block_indicator',
  window: '24h',
  weight: 10,
  minEvidence: 100,
  scored: false,
  collect,
  severity: (value) => piecewiseLinearSeverity(value, 1, 15),
};
