-- dispose-job.sql (P14 Unit U6, phase step 7) - terminates a job the guard
-- pipeline denied with a TERMINAL reason (`DENY_REASON_EFFECTS[reason].
-- jobOutcome !== 'queued'`: OPT_OUT -> cancelled, BLOCKED_WORD /
-- LINK_IN_FIRST_MESSAGE -> failed).
--
-- BIND PARAMETERS (loadQuery('dispose-job').paramNames is the authoritative
-- runtime-verified order): id, client_id, lease_id, outcome, reason.
-- RETURNING: id (present only when the guarded UPDATE actually matched a
-- row - see the claim-lost note below).
--
-- COLUMN CONVENTIONS - mirrors result.ts's own terminal-write shapes
-- exactly (never a third, competing convention):
--   OPT_OUT ($outcome = 'cancelled'): cancel_reason = 'opt_out' (the SAME
--     literal dispatch-optout-precheck.ts's pre-send cancel already writes,
--     never the raw reason string) - last_error_class stays NULL, a
--     cancellation is not an error.
--   BLOCKED_WORD / LINK_IN_FIRST_MESSAGE ($outcome = 'failed'):
--     last_error_class = $reason AND cancel_reason = $reason, same paired
--     write result.ts's own FAIL_PERMANENT branch uses for a provider
--     permanent-validation failure.
-- pacing_deny_reason is ALWAYS set to $reason regardless of outcome - the
-- one column that records which guard actually fired, terminal or not.
--
-- LEASE-GUARDED, CLAIM-LOST IS A NORMAL OUTCOME: the WHERE clause matches
-- status = 'processing' AND lease_id = $lease_id, the same guard shape
-- result.ts's own terminal writes use. Zero rows means another worker's
-- claim already replaced this lease (a lost claim between this job's own
-- claim and this guard evaluation, still inside the SAME transaction in
-- practice today, but the guard is kept anyway for defence in depth and
-- parity with every other terminal write in this codebase) - the caller
-- treats an empty RETURNING set as "nothing to do", never an error.
--
-- Lease fields are cleared (lease_owner, lease_id, owner_fence, leased_at,
-- lease_expires_at all NULL) and pacing_reserved_at is cleared too - a
-- disposed job holds no lease and no pacing unit (it was never reserved
-- for one; the guard pipeline runs BEFORE reserve() in claimAndReserve's
-- own ordering, see send-loop-pacing-claim.ts's module doc).
-- PARAMETER TYPING NOTE: `$outcome` is bound once as `text` (cast explicitly
-- everywhere it is compared - `($outcome)::text = '...'`) and cast to the
-- `job_status` enum only at the one SET-target position that needs it
-- (`status = ($outcome)::job_status`). Without the explicit casts, Postgres's
-- extended-query-protocol planner deduces the enum type from `SET status =
-- $outcome` and then rejects the LATER `$outcome = 'cancelled'`/`= 'failed'`
-- text comparisons in the CASE branches below with "inconsistent types
-- deduced for parameter" - found live by this unit's own integration test.
UPDATE message_jobs
   SET status = ($outcome)::job_status,
       cancel_reason = CASE WHEN ($outcome)::text = 'cancelled' THEN 'opt_out' ELSE $reason END,
       last_error_class = CASE WHEN ($outcome)::text = 'failed' THEN $reason ELSE last_error_class END,
       pacing_deny_reason = $reason,
       terminal_at = now(),
       failed_at = CASE WHEN ($outcome)::text = 'failed' THEN now() ELSE failed_at END,
       lease_owner = NULL,
       lease_id = NULL,
       owner_fence = NULL,
       leased_at = NULL,
       lease_expires_at = NULL,
       pacing_reserved_at = NULL,
       updated_at = now()
 WHERE id = $id AND client_id = $client_id AND status = 'processing' AND lease_id = $lease_id
RETURNING id;
