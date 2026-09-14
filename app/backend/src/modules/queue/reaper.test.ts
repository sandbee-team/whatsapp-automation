import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { classifyReapedRow, REAP_OUTCOMES, type ReapedRow } from './reaper.js';

/**
 * reaper.test.ts (P12 Unit U2, step 3) - unit-tests the PURE classification
 * core (`reaper.ts#classifyReapedRow`) against fabricated rows shaped exactly
 * like `wp_reap_expired_leases`'s RETURNING projection (migration 0027). This
 * repo has no in-memory DB fake, so the DB-driving wrapper (metrics, delivery
 * events, the money-seam sink call) is proved by `reaper.integration.test.ts`
 * instead - this file proves the OUTCOME CLASSIFICATION table alone: which
 * `outcome` label a row maps to, whether it emits a delivery event, and
 * whether it repairs a send (sink call).
 */

function baseRow(overrides: Partial<ReapedRow> = {}): ReapedRow {
  return {
    clientId: 'client-1',
    instanceId: 'instance-1',
    messageJobId: '1',
    messageJobCreatedAt: new Date('2026-09-01T12:00:00.000Z'),
    newStatus: 'queued',
    attemptState: null,
    sendAttemptId: null,
    sendAttemptNo: null,
    errorClass: null,
    maxAttempts: null,
    ...overrides,
  };
}

describe('classifyReapedRow', () => {
  it('prepared_attempt_requeues_and_decrements_attempts_by_one', () => {
    // Contract row 2: attempt_state='prepared', new_status='queued' - the SQL
    // function already decremented `attempts`; this module owes only the
    // metric, no delivery event, no sink call.
    const row = baseRow({
      newStatus: 'queued',
      attemptState: 'prepared',
      sendAttemptId: '10',
      sendAttemptNo: 1,
    });

    const outcome = classifyReapedRow(row);

    expect(outcome.metricOutcome).toBe('requeued_prepared');
    expect(outcome.emitDeliveryEvent).toBe(false);
    expect(outcome.repairsSend).toBe(false);
    expect(outcome.marksUnresolved).toBe(false);
  });

  it('no_attempt_row_requeues_without_touching_attempts', () => {
    // Contract row 1: attempt_state=null, new_status='queued' - attempts was
    // never incremented, so nothing to decrement either.
    const row = baseRow({ newStatus: 'queued', attemptState: null });

    const outcome = classifyReapedRow(row);

    expect(outcome.metricOutcome).toBe('requeued_no_attempt');
    expect(outcome.emitDeliveryEvent).toBe(false);
    expect(outcome.repairsSend).toBe(false);
    expect(outcome.marksUnresolved).toBe(false);
  });

  it('dispatched_attempt_becomes_needs_reconcile_never_queued', () => {
    // Contract row 3: attempt_state='dispatched', new_status='needs_reconcile'
    // - never requeued (invariant 2); metric + wp_unresolved_jobs_total only.
    const row = baseRow({
      newStatus: 'needs_reconcile',
      attemptState: 'dispatched',
      sendAttemptId: '11',
      sendAttemptNo: 1,
    });

    const outcome = classifyReapedRow(row);

    expect(outcome.metricOutcome).toBe('needs_reconcile');
    expect(outcome.emitDeliveryEvent).toBe(false);
    expect(outcome.repairsSend).toBe(false);
    expect(outcome.marksUnresolved).toBe(true);
  });

  it('acked_attempt_is_repaired_to_sent_with_the_attempt_resolved_at', () => {
    // Contract row 4: attempt_state='acked', new_status='sent' - ONE
    // delivery_events(event_type='reconciled') + ONE
    // RepairedSendSink.onRepairedSent(send_attempt_id).
    const row = baseRow({
      newStatus: 'sent',
      attemptState: 'acked',
      sendAttemptId: '12',
      sendAttemptNo: 1,
    });

    const outcome = classifyReapedRow(row);

    expect(outcome.metricOutcome).toBe('repaired_sent');
    expect(outcome.emitDeliveryEvent).toBe(true);
    expect(outcome.repairsSend).toBe(true);
    expect(outcome.marksUnresolved).toBe(false);
  });

  it('failed_attempt_requires_async_reclassification_and_names_no_metric_up_front', () => {
    // Migration 0029 (P12 C1 review, CRITICAL finding 2): the SQL no longer
    // decides a `failed` attempt's disposition unconditionally - it moves
    // the job to `needs_reconcile` (same as `dispatched`) and this PURE
    // classifier can no longer name a final metric label without the async
    // re-drive through the REAL `classify()` decision
    // (`reclassifyReapedFailure`, `runOneReaperSweep`'s job). The OLD
    // expectation here (`metricOutcome === 'requeued_failed'`, no delivery
    // event) encoded the blind flat-5s requeue this migration removed
    // because it bypassed the retry matrix and could never pause an
    // instance on a `restricted`/`unknown` signal - see the migration's own
    // header for the full mechanism and fix.
    const row = baseRow({
      newStatus: 'needs_reconcile',
      attemptState: 'failed',
      sendAttemptId: '13',
      sendAttemptNo: 2,
      errorClass: 'transient',
      maxAttempts: 5,
    });

    const outcome = classifyReapedRow(row);

    expect(outcome.metricOutcome).toBeNull();
    expect(outcome.requiresFailureReclassify).toBe(true);
    expect(outcome.emitDeliveryEvent).toBe(false);
    expect(outcome.repairsSend).toBe(false);
    expect(outcome.marksUnresolved).toBe(false);
  });

  it('the_outcome_label_union_is_closed_and_matches_every_classified_value', () => {
    // Migration 0029: `requeued_failed` removed, three new `failed_*` labels
    // added (one per `reclassifyReapedFailure`'s `ReclassifyOutcome`) - see
    // `reaper.ts`'s own `REAP_OUTCOMES` doc comment.
    expect(REAP_OUTCOMES).toEqual([
      'requeued_no_attempt',
      'requeued_prepared',
      'needs_reconcile',
      'repaired_sent',
      'failed_terminal',
      'failed_paused',
      'failed_retry_scheduled',
    ]);
  });
});
