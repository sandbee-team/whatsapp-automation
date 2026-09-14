import { describe, expect, it } from 'vitest';
import type { CollectCtx } from './signals/types.js';
import type { WindowRow } from './signals/window-row.js';
import { computeHealthScore, type PriorEvidence } from './score.js';

/** Local mirror of `bands.ts`'s `bandForScore` boundaries (design §3.2) - kept inline rather than importing `bands.ts` internals, since this test only needs the READ-ONLY threshold check, not the full band-transition machinery `bands.test.ts` owns. */
function bandLabelFor(score: number): 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'CRITICAL' {
  if (score >= 70) return 'HEALTHY';
  if (score >= 55) return 'WATCH';
  if (score >= 35) return 'DEGRADED';
  return 'CRITICAL';
}

/**
 * score.test.ts (P16 Unit B, step 4) - exact-value scoring tests, driven by
 * a stubbed `sql`. Named tests exactly per the phase file.
 */

const NOW = new Date('2026-09-03T00:00:00.000Z');

function stubCtx(row: Partial<WindowRow>): CollectCtx {
  const fullRow: WindowRow = {
    disconnect_count_6h: 0,
    reconnect_churn_count_6h: 0,
    last_hard_signal_audit_at: null,
    attempted_1h: 0,
    transient_failed_1h: 0,
    attempted_24h: 0,
    rejected_failed_24h: 0,
    invalid_jid_failed_24h: 0,
    eligible_sent_24h: 0,
    delivered_24h: 0,
    read_24h: 0,
    sent_24h: 0,
    opt_outs_24h: 0,
    new_convs_72h: 0,
    cold_sent_24h: 0,
    ...row,
  };
  return {
    sql: {
      query: async <T extends Record<string, unknown> = Record<string, unknown>>() => ({
        rows: [fullRow as unknown as T],
        rowCount: 1,
      }),
    },
    instanceId: '11111111-1111-1111-1111-111111111111',
    clientId: '22222222-2222-2222-2222-222222222222',
    now: () => NOW,
  };
}

describe('score', () => {
  it('reply_rate_alone_cannot_leave_healthy_or_pause', async () => {
    // 0% reply rate (reply_rate is permanently unmeasured in v1 regardless
    // - design-suite test 14 / SM-14), every scored signal perfect.
    const ctx = stubCtx({
      attempted_24h: 20,
      rejected_failed_24h: 0,
      eligible_sent_24h: 30,
      delivered_24h: 30,
      new_convs_72h: 0,
    });
    const { score, evidence } = await computeHealthScore(ctx, {});
    expect(score).toBe(100);
    expect(bandLabelFor(score)).toBe('HEALTHY');
    expect(evidence.reply_rate?.unmeasured).toBe(true);
    expect(evidence.reply_rate?.weightApplied).toBe(0);
  });

  it('one_bad_tick_cannot_move_a_band', async () => {
    // Healthy baseline prior (severity 0 on every scored signal), then ONE
    // tick where rejected_send_rate reads 100% failure (worst possible
    // severity, 1). EWMA alpha=0.3: smoothed = 0.3*1 + 0.7*0 = 0.3.
    // Penalty = weight(12) * 0.3 = 3.6. Score = 100 - 3.6 = 96.4 exactly -
    // nowhere near the HEALTHY(70)/WATCH(55) boundary.
    const prior: PriorEvidence = {
      hard_restriction: { severity: 0 },
      rejected_send_rate: { severity: 0 },
      delivery_ratio: { severity: 0 },
    };
    const ctx = stubCtx({
      attempted_24h: 20,
      rejected_failed_24h: 20,
      eligible_sent_24h: 30,
      delivered_24h: 30,
    });
    const { score } = await computeHealthScore(ctx, prior);
    expect(score).toBe(96.4);
    expect(bandLabelFor(score)).toBe('HEALTHY');
  });

  it('evidence_records_numerator_denominator_and_weight_applied', async () => {
    const ctx = stubCtx({
      attempted_24h: 20,
      rejected_failed_24h: 1,
      eligible_sent_24h: 30,
      delivered_24h: 28,
      attempted_1h: 20,
      transient_failed_1h: 1,
    });
    const { evidence } = await computeHealthScore(ctx, {});

    const scoredKeys = ['hard_restriction', 'rejected_send_rate', 'delivery_ratio'];
    const unscoredKeys = [
      'disconnect_frequency',
      'reconnect_churn',
      'transient_failure_rate',
      'read_ratio',
      'invalid_jid_rate',
      'recipient_block_indicator',
      'opt_out_rate',
      'reply_rate',
      'cold_outreach_ratio',
    ];

    for (const key of scoredKeys) {
      expect(evidence[key]).toBeDefined();
    }
    for (const key of unscoredKeys) {
      expect(evidence[key]).toBeDefined();
      expect(evidence[key]?.weightApplied).toBe(0);
    }

    // rejected_send_rate: 1/20 = 0.05 exactly.
    expect(evidence.rejected_send_rate?.numerator).toBe(1);
    expect(evidence.rejected_send_rate?.denominator).toBe(20);
    expect(evidence.rejected_send_rate?.value).toBe(0.05);
    expect(evidence.rejected_send_rate?.weightApplied).toBe(12);

    // transient_failure_rate is unscored but still fully evidenced.
    expect(evidence.transient_failure_rate?.numerator).toBe(1);
    expect(evidence.transient_failure_rate?.denominator).toBe(20);
    expect(evidence.transient_failure_rate?.weightApplied).toBe(0);
  });

  it('an_all_zero_window_row_leaves_only_the_three_always_measured_count_signals_measured', async () => {
    // Empty/zero window row (brand-new instance, no send history at all).
    // Ratio-shaped signals gate on their denominator via ratio-evidence.ts
    // ("denominator <= 0 -> 'unmeasured', NEVER 0") - every one of those
    // reports 'unmeasured' here. Three signals bypass that gate entirely and
    // are ALWAYS measured, by design (each one's own module doc: "min
    // evidence: none" for a count-shaped signal, zero being itself valid
    // evidence): hard_restriction (event-override, denominator fixed at 1),
    // disconnect_frequency and reconnect_churn (6h counts, denominator fixed
    // at 1). This is the exact, verified reason a fully-unmeasured 12-signal
    // vector can never occur - exactly 3 of 12 keys are always measured, the
    // other 9 are 'unmeasured' when every window is empty.
    const ctx = stubCtx({});
    const { score, evidence } = await computeHealthScore(ctx, {});

    expect(score).toBe(100);

    const ALWAYS_MEASURED_KEYS = ['hard_restriction', 'disconnect_frequency', 'reconnect_churn'];
    for (const key of ALWAYS_MEASURED_KEYS) {
      expect(evidence[key]?.unmeasured).toBe(false);
      expect(evidence[key]?.value).toBe(0);
    }

    const allKeys = Object.keys(evidence);
    expect(allKeys).toHaveLength(12);
    const unmeasuredKeys = allKeys.filter((key) => evidence[key]?.unmeasured === true);
    expect(unmeasuredKeys).toHaveLength(9);
    for (const key of ALWAYS_MEASURED_KEYS) {
      expect(unmeasuredKeys).not.toContain(key);
    }

    // The full vector must still be JSON-serializable and bounded (no NaN/
    // Infinity/circular structure) - this is the exact evidence shape
    // hard-signal-pause.ts's buildEvidencePayload embeds into a pacing_events
    // row, so a crash here would crash a real pause write.
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toMatch(/NaN|Infinity/);
    expect(JSON.parse(serialized)).toEqual(evidence);
  });

  it('a_fresh_hard_restriction_fires_the_override_on_the_first_tick_even_with_healthy_prior_evidence', async () => {
    // CRITICAL 1 fix (P16 fix round): the override is a boolean FACT about
    // this tick's fresh evidence, never an EWMA-smoothed rate - a prior
    // severity of 0 must not dilute a fresh restriction below the `>= 1`
    // threshold. Exact 0 on the FIRST tick (not a bound - a bound would also
    // pass the broken smoothed-then-compare code from tick 4 onward, since
    // repeated restrictions eventually smooth back up to 1).
    const prior: PriorEvidence = {
      hard_restriction: { severity: 0 },
      rejected_send_rate: { severity: 0 },
      delivery_ratio: { severity: 0 },
    };
    const ctx = stubCtx({
      last_hard_signal_audit_at: new Date('2026-09-02T12:00:00.000Z'), // 12h before NOW - inside the 24h window.
    });
    const { score, evidence } = await computeHealthScore(ctx, prior);
    expect(score).toBe(0);
    expect(evidence.hard_restriction?.severity).toBe(1);
  });
});
