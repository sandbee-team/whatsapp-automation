/**
 * The durable job status FSM, modelled as DATA (an explicit edge list), not
 * as branching code - so `canTransition` can never silently allow an
 * undeclared edge and the whole graph is inspectable/testable at once.
 *
 * States mirror the canonical `job_status` Postgres enum [R-31]
 * (`.memory/research/2026-08-25-v1-architecture-blueprint.md` lines
 * 208-222): `created, queued, processing, sent, failed, cancelled,
 * needs_reconcile, blocked_needs_review`.
 *
 * Edges (each cites the blueprint text it comes from; conservative reading
 * used wherever the text left an edge ambiguous - see P00 task summary):
 *
 *   created  -> queued                 lifecycle steps 1-2 (API validates,
 *                                       then the job waits with priority
 *                                       metadata)
 *   queued   -> processing             the canonical claim (`claim-jobs.sql`)
 *   queued   -> cancelled              content guard / opt-out at claim time
 *                                       ("claim-time content guard" ->
 *                                       cancelled, cancel_reason='opt_out')
 *   processing -> sent                 dispatch acked
 *   processing -> queued               reaper repairs a `prepared`/`failed`
 *                                       attempt back to queued; also
 *                                       transient/not_connected/rate_limited
 *                                       retry classes requeue with backoff
 *   processing -> failed               invalid_recipient/invalid_payload
 *                                       retry classes -> terminal failed
 *   processing -> needs_reconcile      reaper: a `dispatched` attempt with
 *                                       no resolution before lease expiry
 *   processing -> cancelled            pre-send content guard / opt-out
 *   needs_reconcile -> sent            echo evidence match within the
 *                                       10-minute reconcile window
 *   needs_reconcile -> blocked_needs_review
 *                                       window expires with no evidence
 *   blocked_needs_review -> queued     explicit user action, "Retry (may
 *                                       duplicate)" - the ONLY way out other
 *                                       than Discard; never automatic under
 *                                       the default `ask_me` policy
 *   blocked_needs_review -> cancelled  explicit user action, "Discard (may
 *                                       have been delivered)"
 *
 * Deliberately NOT modelled (conservative reading - fewer edges):
 *   - `needs_reconcile -> queued` directly. The non-default
 *     `ambiguous_send_policy='resend_once'` setting can auto-resend, but
 *     that is a policy-level action layered on top of the FSM, not a bare
 *     state edge, and the mandated test is that the DEFAULT policy never
 *     auto-requeues an unresolved job.
 *   - `created -> cancelled`. Opt-out at API-creation time returns 422 with
 *     no row created at all ("no row, no charge") - there is no job to
 *     transition.
 */

export type JobStatus =
  | 'created'
  | 'queued'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'cancelled'
  | 'needs_reconcile'
  | 'blocked_needs_review';

export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = Object.freeze({
  created: Object.freeze<JobStatus[]>(['queued']),
  queued: Object.freeze<JobStatus[]>(['processing', 'cancelled']),
  processing: Object.freeze<JobStatus[]>([
    'sent',
    'queued',
    'failed',
    'needs_reconcile',
    'cancelled',
  ]),
  sent: Object.freeze<JobStatus[]>([]),
  failed: Object.freeze<JobStatus[]>([]),
  cancelled: Object.freeze<JobStatus[]>([]),
  needs_reconcile: Object.freeze<JobStatus[]>(['sent', 'blocked_needs_review']),
  blocked_needs_review: Object.freeze<JobStatus[]>(['queued', 'cancelled']),
});

/** States with zero declared outgoing edges - a job here never moves again. */
export const TERMINAL_JOB_STATES: readonly JobStatus[] = Object.freeze(
  (Object.keys(JOB_TRANSITIONS) as JobStatus[]).filter(
    (state) => JOB_TRANSITIONS[state].length === 0,
  ),
);

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}
