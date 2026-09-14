import type { CollectCtx, CollectedEvidence, Signal } from './types.js';
import { fetchWindowRow, toCount } from './window-row.js';
import { piecewiseLinearSeverity } from './types.js';
import { ratioEvidence } from './ratio-evidence.js';

/**
 * signals/transient-failure-rate.ts (P16 Unit B, step 3) - 1h
 * failed(transient)/attempted ratio. Design table: weight 8, good<=2%,
 * bad>=25%, min evidence 20 attempts.
 */
async function collect(ctx: CollectCtx): Promise<CollectedEvidence> {
  const row = await fetchWindowRow(ctx);
  const attempted = toCount(row.attempted_1h);
  const failed = toCount(row.transient_failed_1h);
  return ratioEvidence(failed, attempted, 20);
}

export const transientFailureRateSignal: Signal = {
  key: 'transient_failure_rate',
  window: '1h',
  weight: 8,
  minEvidence: 20,
  scored: false,
  collect,
  severity: (value) => piecewiseLinearSeverity(value, 0.02, 0.25),
};
