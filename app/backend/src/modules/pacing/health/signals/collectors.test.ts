import { describe, expect, it } from 'vitest';
import type { CollectCtx } from './types.js';
import { transientFailureRateSignal } from './transient-failure-rate.js';
import { replyRateSignal } from './reply-rate.js';
import { readRatioSignal } from './read-ratio.js';
import type { WindowRow } from './window-row.js';

/**
 * collectors.test.ts (P16 Unit B, step 3) - collector honesty tests, driven
 * by a stubbed `sql` (fake rows), never real PG. Named tests per the phase
 * file exactly.
 */

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
    now: () => new Date('2026-09-03T00:00:00.000Z'),
  };
}

describe('signals/collectors', () => {
  it('min_evidence_protects_new_instances', async () => {
    // 4 sends / 1 failure in the 1h transient window - below the 20-attempt
    // min-evidence floor, so this signal must contribute 0 penalty (i.e.
    // report 'unmeasured'), matching design-suite test 15 (SM-15).
    const ctx = stubCtx({ attempted_1h: 4, transient_failed_1h: 1 });
    const result = await transientFailureRateSignal.collect(ctx);
    expect(result).toBe('unmeasured');
  });

  it('an_empty_source_returns_unmeasured_not_zero', async () => {
    // reply_rate: permanently unmeasured (no inbound-message source in v1),
    // regardless of what the window row reports.
    const replyResult = await replyRateSignal.collect(stubCtx({ new_convs_72h: 500 }));
    expect(replyResult).toBe('unmeasured');

    // read_ratio: an empty source (zero delivered, so zero possible reads)
    // must return 'unmeasured', never a computed 0.
    const readResult = await readRatioSignal.collect(stubCtx({ delivered_24h: 0, read_24h: 0 }));
    expect(readResult).toBe('unmeasured');
  });
});
