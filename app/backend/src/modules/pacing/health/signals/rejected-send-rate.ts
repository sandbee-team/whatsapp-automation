import type { CollectCtx, CollectedEvidence, Signal } from './types.js';
import { fetchWindowRow, toCount } from './window-row.js';
import { piecewiseLinearSeverity } from './types.js';
import { ratioEvidence } from './ratio-evidence.js';

/**
 * signals/rejected-send-rate.ts (P16 Unit B, step 3) - 24h
 * failed(rejected-by-provider)/attempted ratio - one of the exactly-three
 * SCORED v1 signals (design canon, blueprint [R-27s]). Design table:
 * weight 12, good=0%, bad>=5%, min evidence 20 attempts. "Rejected by
 * provider" maps to `send_attempts.error_class IN ('restricted',
 * 'rate_limited')` (`provider/provider.types.ts`'s `SendErrorClass`) - see
 * `health-signal-windows.sql`'s `rejected_failed_24h` column.
 */
async function collect(ctx: CollectCtx): Promise<CollectedEvidence> {
  const row = await fetchWindowRow(ctx);
  const attempted = toCount(row.attempted_24h);
  const rejected = toCount(row.rejected_failed_24h);
  return ratioEvidence(rejected, attempted, 20);
}

export const rejectedSendRateSignal: Signal = {
  key: 'rejected_send_rate',
  window: '24h',
  weight: 12,
  minEvidence: 20,
  scored: true,
  collect,
  severity: (value) => piecewiseLinearSeverity(value, 0, 0.05),
};
