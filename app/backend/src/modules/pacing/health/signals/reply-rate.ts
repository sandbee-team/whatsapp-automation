import type { CollectedEvidence, Signal } from './types.js';
import { piecewiseLinearSeverity } from './types.js';

/**
 * signals/reply-rate.ts (P16 Unit B, step 3) - replies / new conversations,
 * 72h. Design table: weight 10, good>=8%, bad<=0.5%, min evidence 50 new
 * convs. PERMANENTLY `'unmeasured'` in v1 (dispatch's explicit instruction:
 * "reply_rate has NO source in v1 - no inbound messages stored") - there is
 * no inbound-message table in this schema to count a "reply" against, so
 * this collector never even reads `health-signal-windows.sql`'s
 * `new_convs_72h` column; it always returns `'unmeasured'` regardless of
 * conversation volume. `reply_rate_alone_cannot_leave_healthy_or_pause`
 * (design-suite test 14, SM-14) depends on this: an always-unmeasured signal contributes
 * zero penalty forever, so it can never by itself move the score or band.
 */
function collect(): CollectedEvidence {
  return 'unmeasured';
}

export const replyRateSignal: Signal = {
  key: 'reply_rate',
  window: '72h',
  weight: 10,
  minEvidence: 50,
  scored: false,
  collect,
  severity: (value) => piecewiseLinearSeverity(value, 0.08, 0.005),
};
