import type { CollectCtx, CollectedEvidence, Signal } from './types.js';
import { fetchWindowRow, toCount } from './window-row.js';
import { piecewiseLinearSeverity } from './types.js';

/**
 * signals/disconnect-frequency.ts (P16 Unit B, step 3) - 6h count of
 * connected-exit events, excluding restriction signals and our own
 * expected-takeover restarts (see `health-signal-windows.sql`'s
 * `disconnect_count_6h` column doc). Design table: weight 15, good<=1,
 * bad>=8, "min evidence: none" - a count-shaped signal is always measured
 * (zero disconnects in the window is itself valid evidence), never
 * `'unmeasured'`.
 */
async function collect(ctx: CollectCtx): Promise<CollectedEvidence> {
  const row = await fetchWindowRow(ctx);
  const value = toCount(row.disconnect_count_6h);
  return { numerator: value, denominator: 1, value };
}

export const disconnectFrequencySignal: Signal = {
  key: 'disconnect_frequency',
  window: '6h',
  weight: 15,
  minEvidence: 0,
  scored: false,
  collect,
  severity: (value) => piecewiseLinearSeverity(value, 1, 8),
};
