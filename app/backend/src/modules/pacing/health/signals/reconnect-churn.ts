import type { CollectCtx, CollectedEvidence, Signal } from './types.js';
import { fetchWindowRow, toCount } from './window-row.js';
import { piecewiseLinearSeverity } from './types.js';

/**
 * signals/reconnect-churn.ts (P16 Unit B, step 3) - 6h count of
 * restart-shaped reconnects (restartRequired/connectionReplaced/QR-refresh
 * loops - `health-signal-windows.sql`'s `reconnect_churn_count_6h` column).
 * Design table: weight 5, good<=2, bad>=12, "min evidence: none" - same
 * always-measured shape as `disconnect_frequency`.
 */
async function collect(ctx: CollectCtx): Promise<CollectedEvidence> {
  const row = await fetchWindowRow(ctx);
  const value = toCount(row.reconnect_churn_count_6h);
  return { numerator: value, denominator: 1, value };
}

export const reconnectChurnSignal: Signal = {
  key: 'reconnect_churn',
  window: '6h',
  weight: 5,
  minEvidence: 0,
  scored: false,
  collect,
  severity: (value) => piecewiseLinearSeverity(value, 2, 12),
};
