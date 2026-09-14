import { describe, expect, it } from 'vitest';
import { DENY_REASON_EFFECTS, DENY_REASONS } from './deny-reasons.js';

describe('deny-reasons', () => {
  it('every_deny_reason_has_exactly_one_table_row', () => {
    const keys = Object.keys(DENY_REASON_EFFECTS);
    expect(keys.sort()).toEqual([...DENY_REASONS].sort());
    expect(keys.length).toBe(DENY_REASONS.length);
  });

  it('every_deferral_row_never_touches_attempts', () => {
    for (const reason of DENY_REASONS) {
      expect(DENY_REASON_EFFECTS[reason].touchesAttempts).toBe(false);
    }
  });

  it('unknown_is_fixed_hold_60s_and_alerting', () => {
    expect(DENY_REASON_EFFECTS.UNKNOWN.retryAtRule).toEqual({ kind: 'fixedHoldMs', ms: 60_000 });
    expect(DENY_REASON_EFFECTS.UNKNOWN.alerting).toBe(true);
    expect(DENY_REASON_EFFECTS.UNKNOWN.jobOutcome).toBe('queued');
  });

  it('no_ledger_row_is_non_alerting', () => {
    expect(DENY_REASON_EFFECTS.NO_LEDGER_ROW.alerting).toBe(false);
  });

  it('opt_out_is_the_only_cancelled_reason', () => {
    const cancelled = DENY_REASONS.filter((r) => DENY_REASON_EFFECTS[r].jobOutcome === 'cancelled');
    expect(cancelled).toEqual(['OPT_OUT']);
  });

  it('the_two_content_reasons_are_the_only_failed_reasons', () => {
    const failed = DENY_REASONS.filter((r) => DENY_REASON_EFFECTS[r].jobOutcome === 'failed');
    expect(failed.sort()).toEqual(['BLOCKED_WORD', 'LINK_IN_FIRST_MESSAGE'].sort());
  });

  it('group_daily_cap_is_same_class_as_daily_cap', () => {
    expect(DENY_REASON_EFFECTS.GROUP_DAILY_CAP.retryAtRule).toEqual(
      DENY_REASON_EFFECTS.DAILY_CAP.retryAtRule,
    );
    expect(DENY_REASON_EFFECTS.GROUP_DAILY_CAP.jobOutcome).toBe('queued');
    expect(DENY_REASON_EFFECTS.GROUP_DAILY_CAP.touchesAttempts).toBe(false);
  });
});
