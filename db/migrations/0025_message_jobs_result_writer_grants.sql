-- P11 (send-path-mvp) Unit U4 - migration 0025.
-- Forward-only, additive-only widening of wp_scheduler's grants - the
-- "FUTURE WIDENING" migration 0012's own header predicted verbatim: "the
-- P0x result-writer that records sent/failed will need additional
-- message_jobs columns/statements (e.g. writing sent_at, failed_at,
-- attempts, last_error_class) - those are ADDITIVE grants in THEIR OWN
-- migrations when they land, never a reason to re-widen [0012]." This is
-- that migration. No REVOKE anywhere in this file; 0012's narrow claim-only
-- grant is left completely intact.
--
-- COLUMN LISTS ARE DERIVED DIRECTLY FROM engine/queue/dispatch.ts and
-- engine/queue/result.ts, NOT GUESSED - every column below is read or
-- written by name in one of those two files' statements:
--
--   message_jobs UPDATE (attempts)
--     - dispatch.ts's `UPDATE message_jobs SET attempts = attempts + 1 ...`
--       (blueprint pseudocode step 6) - the ONE column 0012 omitted because
--       claim-jobs.sql never increments attempts itself (0012's own header,
--       finding 5: "attempts is NOT incremented here - it increments
--       exactly once with the send_attempts INSERT, later phase" - this is
--       that later phase).
--
--   message_jobs UPDATE (sent_at, failed_at, terminal_at, last_error_class,
--                         next_attempt_at, cancel_reason)
--     - result.ts's job-outcome UPDATE (blueprint pseudocode step 7):
--       sent_at on ack; failed_at + last_error_class on a failed attempt
--       (both the terminal and the requeued-for-retry case record the
--       error class); terminal_at + cancel_reason on FAIL_PERMANENT;
--       next_attempt_at when requeuing after RETRY_BACKOFF. attempts is
--       already covered by the dispatch grant above (result.ts does not
--       independently need a SECOND grant for the same column).
--
--   message_jobs SELECT (max_attempts)
--     - result.ts reads `max_attempts` to decide FAIL_PERMANENT-by-
--       exhaustion vs RETRY_BACKOFF (mj_attempts_range's own CHECK
--       constraint, migration 0007, is the DB-level backstop; the app still
--       needs to READ the ceiling to choose the outcome BEFORE writing).
--       Not previously grantable to wp_scheduler at any column level.
--
-- NOT GRANTED, deliberately, though the task flagged them for
-- consideration:
--   - owner_fence: result.ts's job-outcome UPDATE predicate is exactly
--     `WHERE id=$id AND created_at=$ts AND lease_id=$lease AND
--     status='processing'` (the blueprint pseudocode's own predicate,
--     verbatim) - owner_fence never appears in a WHERE/SET list dispatch.ts
--     or result.ts actually writes, so granting it would be "just in case"
--     over-grant, which the task explicitly forbids.
--   - sent_at/failed_at as SELECT: neither file ever reads these columns
--     back (both are write-only from this unit's point of view) - no SELECT
--     grant needed for either.
--
-- ---------------------------------------------------------------------
-- whatsapp_instances - result.ts's PAUSE_INSTANCE outcome (restricted/
-- unknown provider errors, core invariant 2, fail-safe). Column-scoped,
-- narrower than the plain SELECT-only grant 0010 left wp_scheduler with -
-- this is the FIRST wp_scheduler UPDATE on this table, additive only, no
-- REVOKE of the existing table-level SELECT.
--
-- health_state, pause_reason, paused_at, needs_user_action - the exact
-- column set result.ts's pause-write statement sets, mirroring
-- instance-mark-infra-unavailable.sql's precedent (P09 Unit U3): a
-- client_id-scoped, NON-fence-guarded write, because the queue/send-path
-- worker that runs result.ts is not the actor holding this instance's
-- session lease/fence (that is the session-worker role's own concern,
-- engine/session/**) - same reasoning instance-mark-infra-unavailable.sql's
-- own header already documents for the discovery-escalation write. RLS
-- tenant_isolation (migration 0010) still confines every write to the
-- caller's own client_id.
-- ---------------------------------------------------------------------
GRANT UPDATE (attempts) ON message_jobs TO wp_scheduler;

GRANT UPDATE (sent_at, failed_at, terminal_at, last_error_class, next_attempt_at, cancel_reason)
  ON message_jobs TO wp_scheduler;

GRANT SELECT (max_attempts) ON message_jobs TO wp_scheduler;

GRANT UPDATE (health_state, pause_reason, paused_at, needs_user_action)
  ON whatsapp_instances TO wp_scheduler;
