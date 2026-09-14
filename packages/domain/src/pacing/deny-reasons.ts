/**
 * The deferral/deny-reason table, as DATA (P13 Unit U2, blueprint §
 * "Deferral is not failure", plus the scope delta's Groups addendum).
 *
 * A pacing deny is not a job failure: MOST reasons leave the job `queued`
 * with `attempts` UNCHANGED (a pacing deferral never consumes retry
 * budget - core invariant 5, "pause preserves work", extended to ordinary
 * pacing waits). Two reasons are terminal by design (`OPT_OUT` cancels;
 * the two content reasons fail the recipient, not the whole job), and
 * `UNKNOWN` fails closed with a short hold + an alert rather than ever
 * granting a send it cannot classify (core invariant 2).
 *
 * `retryAtRule` never computes a time - this package has no clock (browser-
 * purity contract, see `../ports.ts`). It emits a RULE the caller (U3/U4,
 * which has clock + DB access) resolves against `next_eligible_at`, the
 * instance's local window, or a fixed hold.
 */

/** A rule the caller resolves against a clock/DB row - never a computed timestamp (this package has no clock). */
export type RetryAtRule =
  | { kind: 'nextEligibleAt' }
  | { kind: 'nextLocalMidnight' }
  | { kind: 'nextWindowOpen' }
  | { kind: 'fixedHoldMs'; ms: number }
  | { kind: 'none' };

export type JobOutcome = 'queued' | 'cancelled' | 'failed';

export interface DenyReasonEffect {
  jobOutcome: JobOutcome;
  /** `false` for every deferral (structural, not conventional): a pacing wait never consumes retry budget. */
  touchesAttempts: boolean;
  retryAtRule: RetryAtRule;
  alerting: boolean;
  /** Free-text note on health-score impact; `'none'` for every deferral reason. */
  healthImpact: 'none' | 'small_penalty_if_repeated' | 'excluded_from_denominator';
}

export const DENY_REASONS = [
  'MIN_GAP',
  'DAILY_CAP',
  'HOURLY_CAP',
  'NEW_CONV_CAP',
  'COLD_RATIO',
  'GROUP_DAILY_CAP',
  'PLAN_CAP',
  'OUTSIDE_WINDOW',
  'PER_RECIPIENT_FREQ',
  'NEEDS_HUMAN_ACK',
  'INSTANCE_PAUSED',
  'NOT_CONNECTED',
  'OPT_OUT',
  'BLOCKED_WORD',
  'LINK_IN_FIRST_MESSAGE',
  'NO_LEDGER_ROW',
  'UNKNOWN',
] as const;

export type DenyReason = (typeof DENY_REASONS)[number];

const QUEUED_NO_RESCHEDULE: DenyReasonEffect = Object.freeze({
  jobOutcome: 'queued',
  touchesAttempts: false,
  retryAtRule: { kind: 'none' as const },
  alerting: false,
  healthImpact: 'none',
});

/** The frozen lookup: every `DenyReason` has exactly one row (asserted in `deny-reasons.test.ts`). */
export const DENY_REASON_EFFECTS: Readonly<Record<DenyReason, DenyReasonEffect>> = Object.freeze({
  MIN_GAP: Object.freeze({
    jobOutcome: 'queued',
    touchesAttempts: false,
    retryAtRule: { kind: 'nextEligibleAt' as const },
    alerting: false,
    healthImpact: 'none',
  }),
  DAILY_CAP: Object.freeze({
    jobOutcome: 'queued',
    touchesAttempts: false,
    retryAtRule: { kind: 'nextLocalMidnight' as const },
    alerting: false,
    healthImpact: 'none',
  }),
  /**
   * The CLIENT-wide plan cap (`effective_client_limits.max_daily_sends`,
   * counted in `client_daily_usage.sent_count`), as opposed to `DAILY_CAP`'s
   * per-instance `eff_daily_cap`. Same deferral shape - it resets at the
   * instance's next LOCAL midnight, same as every other daily counter, since
   * `client_daily_usage` is keyed on the reserve's own local `ledger_date`.
   *
   * Added at P13 close: `db/queries/pacing-deny-reason.sql` had always been
   * able to return this label, but it was unreachable dead code until the C1
   * review's Finding 4 made `sent_count` actually increment. The moment the
   * plan cap could really deny, `DENY_REASON_EFFECTS['PLAN_CAP']` resolved to
   * `undefined` and `reserve()` threw a TypeError instead of deferring the
   * job - i.e. a cap that fires by CRASHING the send loop. Any new label in
   * that SQL file MUST land here in the same change.
   */
  PLAN_CAP: Object.freeze({
    jobOutcome: 'queued',
    touchesAttempts: false,
    retryAtRule: { kind: 'nextLocalMidnight' as const },
    alerting: false,
    healthImpact: 'none',
  }),
  HOURLY_CAP: Object.freeze({
    jobOutcome: 'queued',
    touchesAttempts: false,
    retryAtRule: { kind: 'nextLocalMidnight' as const },
    alerting: false,
    healthImpact: 'none',
  }),
  NEW_CONV_CAP: Object.freeze({
    jobOutcome: 'queued',
    touchesAttempts: false,
    retryAtRule: { kind: 'nextLocalMidnight' as const },
    alerting: false,
    healthImpact: 'none',
  }),
  COLD_RATIO: Object.freeze({
    jobOutcome: 'queued',
    touchesAttempts: false,
    retryAtRule: { kind: 'nextLocalMidnight' as const },
    alerting: false,
    healthImpact: 'none',
  }),
  GROUP_DAILY_CAP: Object.freeze({
    jobOutcome: 'queued',
    touchesAttempts: false,
    retryAtRule: { kind: 'nextLocalMidnight' as const },
    alerting: false,
    healthImpact: 'none',
  }),
  OUTSIDE_WINDOW: Object.freeze({
    jobOutcome: 'queued',
    touchesAttempts: false,
    retryAtRule: { kind: 'nextWindowOpen' as const },
    alerting: false,
    healthImpact: 'none',
  }),
  PER_RECIPIENT_FREQ: Object.freeze({
    jobOutcome: 'queued',
    touchesAttempts: false,
    retryAtRule: { kind: 'nextWindowOpen' as const },
    alerting: false,
    healthImpact: 'none',
  }),
  NEEDS_HUMAN_ACK: Object.freeze({
    jobOutcome: 'queued',
    touchesAttempts: false,
    retryAtRule: { kind: 'none' as const },
    alerting: true,
    healthImpact: 'none',
  }),
  INSTANCE_PAUSED: QUEUED_NO_RESCHEDULE,
  NOT_CONNECTED: QUEUED_NO_RESCHEDULE,
  OPT_OUT: Object.freeze({
    jobOutcome: 'cancelled',
    touchesAttempts: false,
    retryAtRule: { kind: 'none' as const },
    alerting: false,
    healthImpact: 'excluded_from_denominator',
  }),
  BLOCKED_WORD: Object.freeze({
    jobOutcome: 'failed',
    touchesAttempts: false,
    retryAtRule: { kind: 'none' as const },
    alerting: false,
    healthImpact: 'small_penalty_if_repeated',
  }),
  LINK_IN_FIRST_MESSAGE: Object.freeze({
    jobOutcome: 'failed',
    touchesAttempts: false,
    retryAtRule: { kind: 'none' as const },
    alerting: false,
    healthImpact: 'small_penalty_if_repeated',
  }),
  NO_LEDGER_ROW: Object.freeze({
    jobOutcome: 'queued',
    touchesAttempts: false,
    retryAtRule: { kind: 'nextEligibleAt' as const },
    alerting: false,
    healthImpact: 'none',
  }),
  // Fail-closed (core invariant 2): a reason this package cannot classify
  // never grants a send. Short hold + alert, never a grant.
  UNKNOWN: Object.freeze({
    jobOutcome: 'queued',
    touchesAttempts: false,
    retryAtRule: { kind: 'fixedHoldMs' as const, ms: 60_000 },
    alerting: true,
    healthImpact: 'none',
  }),
});
