/**
 * pacing/health-signal-names.ts (P17 Unit U2, step 2) - the twelve health
 * signal keys, in the same declared order as
 * `app/backend/src/modules/pacing/health/signals/registry.ts`'s
 * `HEALTH_SIGNALS` array (that module owns the actual `Signal`
 * implementations - collectors, severity math, evidence I/O - which need
 * `@wp/db` and cannot live in this Node/browser-pure package; this module
 * exists so `packages/contracts`' health/why route can enumerate the same
 * closed set without depending on `app/backend`).
 */
export const HEALTH_SIGNAL_NAMES = [
  'hard_restriction',
  'disconnect_frequency',
  'reconnect_churn',
  'transient_failure_rate',
  'rejected_send_rate',
  'delivery_ratio',
  'read_ratio',
  'invalid_jid_rate',
  'recipient_block_indicator',
  'opt_out_rate',
  'reply_rate',
  'cold_outreach_ratio',
] as const;

export type HealthSignalName = (typeof HEALTH_SIGNAL_NAMES)[number];
