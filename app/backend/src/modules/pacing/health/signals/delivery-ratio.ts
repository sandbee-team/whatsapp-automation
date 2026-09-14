import type { CollectCtx, CollectedEvidence, Signal } from './types.js';
import { fetchWindowRow, toCount } from './window-row.js';
import { piecewiseLinearSeverity } from './types.js';
import { ratioEvidence } from './ratio-evidence.js';

/**
 * signals/delivery-ratio.ts (P16 Unit B, step 3) - 24h delivered/sent ratio,
 * only counting sends >= 30 minutes old - one of the exactly-three SCORED
 * v1 signals. Design table: weight 20, good>=90%, bad<=50%, min evidence 30
 * sends. Legitimately `'unmeasured'` until `delivery_events` carries
 * `'delivered'` rows for this instance (P21) - see this unit's dispatch
 * "Honesty rules".
 */
async function collect(ctx: CollectCtx): Promise<CollectedEvidence> {
  const row = await fetchWindowRow(ctx);
  const eligible = toCount(row.eligible_sent_24h);
  const delivered = toCount(row.delivered_24h);
  return ratioEvidence(delivered, eligible, 30);
}

export const deliveryRatioSignal: Signal = {
  key: 'delivery_ratio',
  window: '24h',
  weight: 20,
  minEvidence: 30,
  scored: true,
  collect,
  // Lower-is-worse (good=0.90 > bad=0.50) - piecewiseLinearSeverity handles
  // this direction the same as the higher-is-worse signals (see its own doc).
  severity: (value) => piecewiseLinearSeverity(value, 0.9, 0.5),
};
