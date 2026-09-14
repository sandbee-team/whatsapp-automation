import type { CollectCtx, CollectedEvidence, Signal } from './types.js';
import { fetchWindowRow, toCount } from './window-row.js';
import { piecewiseLinearSeverity } from './types.js';
import { perThousandEvidence } from './ratio-evidence.js';

/**
 * signals/opt-out-rate.ts (P16 Unit B, step 3) - opt_outs attributed to
 * this instance (`opt_outs.origin_instance_id`) per 1,000 sent, 24h. Design
 * table: weight 15, good<=2, bad>=20, min evidence 100 sends.
 */
async function collect(ctx: CollectCtx): Promise<CollectedEvidence> {
  const row = await fetchWindowRow(ctx);
  const sent = toCount(row.sent_24h);
  const optOuts = toCount(row.opt_outs_24h);
  return perThousandEvidence(optOuts, sent, 100);
}

export const optOutRateSignal: Signal = {
  key: 'opt_out_rate',
  window: '24h',
  weight: 15,
  minEvidence: 100,
  scored: false,
  collect,
  severity: (value) => piecewiseLinearSeverity(value, 2, 20),
};
