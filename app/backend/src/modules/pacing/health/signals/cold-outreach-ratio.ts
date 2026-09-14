import type { CollectCtx, CollectedEvidence, Signal } from './types.js';
import { fetchWindowRow, toCount } from './window-row.js';
import { piecewiseLinearSeverity } from './types.js';
import { ratioEvidence } from './ratio-evidence.js';

/**
 * signals/cold-outreach-ratio.ts (P16 Unit B, step 3) - new_conv sends /
 * total sends, 24h. Design table: weight 10, good<=40%, bad>=90%, min
 * evidence 50 sends.
 */
async function collect(ctx: CollectCtx): Promise<CollectedEvidence> {
  const row = await fetchWindowRow(ctx);
  const sent = toCount(row.sent_24h);
  const cold = toCount(row.cold_sent_24h);
  return ratioEvidence(cold, sent, 50);
}

export const coldOutreachRatioSignal: Signal = {
  key: 'cold_outreach_ratio',
  window: '24h',
  weight: 10,
  minEvidence: 50,
  scored: false,
  collect,
  severity: (value) => piecewiseLinearSeverity(value, 0.4, 0.9),
};
