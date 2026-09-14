import type { CollectCtx, CollectedEvidence, Signal } from './types.js';
import { fetchWindowRow, toCount } from './window-row.js';
import { piecewiseLinearSeverity } from './types.js';
import { ratioEvidence } from './ratio-evidence.js';

/**
 * signals/invalid-jid-rate.ts (P16 Unit B, step 3) - 24h
 * invalid/attempted ratio (`send_attempts.error_class = 'invalid_recipient'`
 * over the same `attempted_24h` denominator `rejected_send_rate` uses).
 * Design table: weight 10, good<=1%, bad>=10%, min evidence 30 attempts.
 */
async function collect(ctx: CollectCtx): Promise<CollectedEvidence> {
  const row = await fetchWindowRow(ctx);
  const attempted = toCount(row.attempted_24h);
  const invalid = toCount(row.invalid_jid_failed_24h);
  return ratioEvidence(invalid, attempted, 30);
}

export const invalidJidRateSignal: Signal = {
  key: 'invalid_jid_rate',
  window: '24h',
  weight: 10,
  minEvidence: 30,
  scored: false,
  collect,
  severity: (value) => piecewiseLinearSeverity(value, 0.01, 0.1),
};
