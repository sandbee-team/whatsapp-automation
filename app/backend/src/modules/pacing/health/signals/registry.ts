import type { Signal } from './types.js';
import { hardRestrictionSignal } from './hard-restriction.js';
import { disconnectFrequencySignal } from './disconnect-frequency.js';
import { reconnectChurnSignal } from './reconnect-churn.js';
import { transientFailureRateSignal } from './transient-failure-rate.js';
import { rejectedSendRateSignal } from './rejected-send-rate.js';
import { deliveryRatioSignal } from './delivery-ratio.js';
import { readRatioSignal } from './read-ratio.js';
import { invalidJidRateSignal } from './invalid-jid-rate.js';
import { recipientBlockIndicatorSignal } from './recipient-block-indicator.js';
import { optOutRateSignal } from './opt-out-rate.js';
import { replyRateSignal } from './reply-rate.js';
import { coldOutreachRatioSignal } from './cold-outreach-ratio.js';

/**
 * signals/registry.ts (P16 Unit B, step 3) - declares all twelve health
 * signals per the canonical table (pasted verbatim into this unit's
 * dispatch). `hard_restriction` is an OVERRIDE (`weight: 0`, excluded from
 * `WEIGHT_SUM`) - not a weighted signal at all; `score.ts` branches on it
 * separately, never folding it into the Σ weight×severity sum. The
 * `rate_limited` fast lane (declared separately, also an override) is NOT a
 * member of this registry - it has no `key`/`window`/evidence shape of its
 * own, it is a boolean fact `bands.ts`'s caller checks directly against
 * `send_attempts.error_class = 'rate_limited'` occurrences.
 *
 * `scored` is exactly `{hard_restriction, rejected_send_rate,
 * delivery_ratio}` in v1 (blueprint [R-27s], ADR 0015) - the other nine
 * signals still collect evidence every tick (so their numerator/denominator/
 * value/severity appear in `score.ts`'s evidence JSON) but contribute
 * `weightApplied: 0`. NEVER wire a weight for an unscored signal - `score.ts`
 * enforces this by reading `scored` off each `Signal`, not by re-deriving it.
 */
export const HEALTH_SIGNALS: readonly Signal[] = [
  hardRestrictionSignal,
  disconnectFrequencySignal,
  reconnectChurnSignal,
  transientFailureRateSignal,
  rejectedSendRateSignal,
  deliveryRatioSignal,
  readRatioSignal,
  invalidJidRateSignal,
  recipientBlockIndicatorSignal,
  optOutRateSignal,
  replyRateSignal,
  coldOutreachRatioSignal,
];

/** The exact v1 scored set (design canon, binding) - `score.test.ts`/`registry.test.ts` assert against this literal, never a derived count. */
export const SCORED_SIGNAL_KEYS: ReadonlySet<string> = new Set([
  'hard_restriction',
  'rejected_send_rate',
  'delivery_ratio',
]);

/** Every signal EXCEPT the `hard_restriction` override - the eleven that carry a real canonical-table weight. */
export const WEIGHTED_SIGNALS: readonly Signal[] = HEALTH_SIGNALS.filter(
  (signal) => signal.key !== 'hard_restriction',
);

/** Sum of `WEIGHTED_SIGNALS[*].weight` - MUST equal 120 (design canon: 15+5+8+12+20+5+10+10+15+10+10 = 120). `registry.test.ts`'s `signal_weights_sum_to_120` asserts this exactly. */
export const WEIGHT_SUM: number = WEIGHTED_SIGNALS.reduce((sum, signal) => sum + signal.weight, 0);
