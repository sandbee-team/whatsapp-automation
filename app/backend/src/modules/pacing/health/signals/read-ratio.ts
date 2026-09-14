import type { CollectCtx, CollectedEvidence, Signal } from './types.js';
import { fetchWindowRow, toCount } from './window-row.js';
import { piecewiseLinearSeverity } from './types.js';
import { ratioEvidence } from './ratio-evidence.js';

/**
 * signals/read-ratio.ts (P16 Unit B, step 3) - 24h read/delivered ratio.
 * Design table: weight 5, good>=40%, bad<=5%, min evidence 50 delivered.
 * Legitimately `'unmeasured'` until `delivery_events` carries `'read'` rows
 * for this instance (P21) - `an_empty_source_returns_unmeasured_not_zero`
 * is this signal's own named mandatory test.
 */
async function collect(ctx: CollectCtx): Promise<CollectedEvidence> {
  const row = await fetchWindowRow(ctx);
  const delivered = toCount(row.delivered_24h);
  const read = toCount(row.read_24h);
  return ratioEvidence(read, delivered, 50);
}

export const readRatioSignal: Signal = {
  key: 'read_ratio',
  window: '24h',
  weight: 5,
  minEvidence: 50,
  scored: false,
  collect,
  severity: (value) => piecewiseLinearSeverity(value, 0.4, 0.05),
};
