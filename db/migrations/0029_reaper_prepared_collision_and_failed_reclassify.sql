-- P12 C1 review fix - migration 0029. Two CRITICAL findings against
-- `wp_reap_expired_leases`, plus one additional finding (4) against
-- `wp_reconcile_scan_unresolved`, both functions from migration 0027.
-- `wp_reap_expired_leases` is fixed by DROP + CREATE (the RETURN TABLE
-- shape gains columns - Postgres refuses `CREATE OR REPLACE` across a
-- changed return type; verified live: "cannot change return type of
-- existing function"). Same `(int, int)` parameter signature, so
-- `db/queries/reap-expired-leases.sql`'s pass-through wrapper (SELECT list
-- widened in the app tree alongside this migration, not a migration
-- change) and every existing caller keep working.
-- `wp_reconcile_scan_unresolved`'s signature AND return shape are both
-- unchanged (finding 4 is a single added predicate), so it uses a plain
-- `CREATE OR REPLACE` (section 2 below).
-- Additive/forward-only: no column dropped, no type changed, no existing
-- policy altered/dropped, `wp_admin_app` gains NOTHING (unchanged from
-- 0027).
--
-- =====================================================================
-- FINDING 1 - the `prepared` repair creates an unbounded attemptNo-
-- collision retry loop
-- =====================================================================
--
-- MECHANISM (verified live against the dev DB before this migration, see
-- this migration's own report): `dispatch()` derives
-- `attemptNo = job.attempts + 1` (`engine/queue/dispatch.ts:258`, FROZEN by
-- P11 - `dispatch.integration.test.ts` pins this identity and migration
-- 0029 does not touch that file or any other file under `engine/queue/
-- dispatch.ts`'s own tree). The reaper's `prepared` branch (0027) decremented
-- `attempts` but left the `send_attempts` row - keyed `UNIQUE
-- (message_job_id, attempt_no)`, migration 0008, a PERMANENT,
-- state-independent constraint - sitting exactly on the slot the
-- decremented counter recomputes on the very next claim. The next
-- `dispatch()` call's `INSERT ... ON CONFLICT (message_job_id, attempt_no)
-- DO NOTHING` finds that row, inserts zero rows, and throws
-- `DispatchAlreadyRecorded` - the job goes back to `queued` with `attempts`
-- unchanged by that failed dispatch, and the SAME `attemptNo` is
-- recomputed on every subsequent claim, forever. `claim-jobs.sql` has no
-- `attempts < max_attempts` predicate (by design - budget exhaustion is a
-- RESULT-time decision, `result-retry-budget.ts`), so this loop never
-- reaches `max_attempts` and never terminates on its own.
--
-- THREE CANDIDATE FIXES WERE CONSIDERED. The first two are rejected; the
-- third is the one shipped below.
--
--   REJECTED (a) "retire the attempt row's STATE to `abandoned`, keep the
--   `attempts - 1` decrement." Does not fix the loop: `UNIQUE
--   (message_job_id, attempt_no)` has no state predicate, so an
--   `abandoned` row still permanently occupies the slot and `ON CONFLICT
--   DO NOTHING` still fires forever regardless of the row's `state` value.
--   Verified against the constraint definition (migration 0008) before
--   rejecting.
--
--   REJECTED (b) "DELETE the stale row, keep the decrement." Fixes the
--   loop (the vacated slot lets a fresh INSERT succeed) and was this
--   migration's FIRST implementation - but it requires granting `wp_reaper`
--   DELETE on `send_attempts`, which contradicts an existing, deliberate,
--   founder-authored invariant test
--   (`db/tests/wp-reaper-role.test.ts`'s
--   `wp_reaper_has_no_grant_beyond_message_jobs_and_send_attempts`,
--   explicit assertion: "send_attempts must be SELECT-only for wp_reaper -
--   it never writes there"). Postgres has no column-scoped DELETE grant,
--   so satisfying this fix would require either a table-level DELETE grant
--   (which the test explicitly forbids: `role_table_grants` count for
--   wp_reaper must be `0`) or weakening that test - and this dispatch's own
--   constraints say to report a contradiction rather than work around an
--   existing hardening test. Rejected on that basis; not implemented in the
--   final migration (verified live it DID work mechanically before being
--   reverted for this reason - see this migration's own report for the
--   revert transcript).
--
-- CHOSEN (c): stop decrementing `attempts` for the `prepared` branch
-- specifically (the no-attempt-row branch, WHEN e.attempt_state IS NULL,
-- is UNCHANGED and still never touches `attempts` - that branch's own
-- history, canon's note in `plan/v1/P12-...md` line 373, is why THAT
-- branch must never decrement; this migration does not reopen that bug).
-- `attempts` now only ever moves forward for a `prepared` repair, so
-- `dispatch()`'s `attemptNo = job.attempts + 1` always names a slot with NO
-- existing `send_attempts` row - `send_attempts` is APPEND-ONLY per
-- attempt_no from `wp_reap_expired_leases`' point of view, and the
-- collision cannot occur structurally. `wp_reaper` needs no new grant for
-- this half of the fix (still SELECT-only on send_attempts, still the same
-- message_jobs UPDATE column set as 0027).
--
-- This DOES cost the job one real attempt out of its budget for a
-- `prepared`-crash that never reached the provider - `db/tests/reaper-
-- repair-contract.test.ts`'s existing assertion
-- (`preparedAfter.attempts).toBe(0)` - was 1, minus 1) is UPDATED by this
-- migration's companion test change to assert `attempts` stays at 1
-- (unchanged), with the justification recorded in that test file itself.
-- `reaper.test.ts`'s `prepared_attempt_requeues_and_decrements_attempts_
-- by_one` is a PURE unit test of `classifyReapedRow` (a RETURNING-row
-- classifier) - it asserts metric/side-effect labels only, never DB
-- decrement arithmetic, so it is unaffected by this change and stays green
-- unmodified (verified by reading it before making this claim).
--
-- THE INVARIANT THIS FIX MUST HOLD (stated explicitly, per the review's own
-- requirement): `message_jobs.attempts` and the set of EXISTING
-- `send_attempts.attempt_no` values for that job can never disagree in a
-- way that makes the next `dispatch()`-derived `attemptNo` collide. Proof:
-- a `prepared` repair no longer changes `attempts` at all, so the LIVE
-- `attempts` value the next claim reads is exactly the value that was live
-- when `dispatch()` last computed `attemptNo` for THIS row (the one that
-- crashed) - `attemptNo(next) = attempts(unchanged) + 1 = attemptNo(crashed)
-- + 1`, strictly greater than every `attempt_no` in `send_attempts` for
-- this job (attempt_no values are assigned monotonically increasing, one
-- per dispatch() call, by construction). No `ON CONFLICT` branch can ever
-- fire for a value that has never existed. Proved by
-- `db/tests/reaper-repair-contract.test.ts`'s updated case and, end-to-end
-- through the REAL `dispatch()` derivation (not a hand-written INSERT), by
-- `app/backend/src/modules/queue/reaper-prepared-collision.integration.test.ts`
-- (new, this review round).
--
-- FOLLOW-UP FOUND BY THIS MIGRATION'S OWN REPEATED-CYCLE TEST (`app/backend
-- /src/modules/queue/reaper-prepared-collision-loop.integration.test.ts`):
-- once the decrement stops, `attempts` only ever moves FORWARD - and
-- `claim-jobs.sql` has no `attempts < max_attempts` predicate (budget
-- exhaustion is deliberately a result-time decision, not a claim-time one -
-- see that file's own header). A job that crashes at `prepared` on EVERY
-- attempt (never once reaching the provider) can therefore be reclaimed
-- past its budget, and the (N+1)th such cycle's `dispatch()` UPDATE hits
-- `mj_attempts_range`'s CHECK (`attempts <= max_attempts + 1`, migration
-- 0007) as a RAW, unhandled Postgres error - never a clean terminal state.
-- Verified live: the test failed with exactly this Postgres error before
-- the fix below was added. Fixed by adding ONE more branch to the CASE
-- below: a `prepared` repair whose `j.attempts >= j.max_attempts` goes
-- terminal (`status='failed'`, `failed_at`, `terminal_at`,
-- `last_error_class='prepared_crash_exhausted'`) instead of `queued` -
-- mirroring `result-retry-budget.ts#isRetryBudgetExhausted`'s SAME
-- `attemptNo >= maxAttempts` comparator (the attempt that just crashed IS
-- `j.attempts`, since `prepareAndIncrement` already incremented it before
-- the crash) and `writeTerminalByExhaustion`'s SAME terminal shape - never
-- re-derived, only mirrored in SQL because this statement has no
-- result-write path to call into. A terminal job is never reclaimed again,
-- so this cannot reopen the collision the rest of this finding fixes - it
-- only closes the one remaining path to an unbounded reclaim loop.
--
-- =====================================================================
-- FINDING 2 - the `failed` repair bypasses the retry matrix and never
-- pauses on a restriction signal
-- =====================================================================
--
-- MECHANISM: the 0027 `CASE` mapped `attempt_state = 'failed'`
-- unconditionally to `'queued'` with a flat `next_attempt_at = now() + 5s`,
-- deciding a failure's disposition in SQL. But `@wp/domain`'s `classify()`
-- (`packages/domain/src/retry/classify.ts`) is the single authority for
-- that decision and has THREE outcomes, not one - `FAIL_PERMANENT`
-- (terminal, never retry), `PAUSE_INSTANCE` (pause + hold, no retry timer -
-- and `restricted`/`unknown` categories short-circuit to this BEFORE the
-- category table is even consulted, core invariant 2), and `RETRY_BACKOFF`
-- (jittered exponential backoff, not a flat delay). The SQL `CASE` had none
-- of this information (`send_attempts.error_class`, written by
-- `result.ts`'s attempt-state write before the crash, was not even
-- projected) and, worse, its blind `-> queued` requeue is exactly the
-- automatic-repeated-sending-after-a-restriction-signal the retry matrix
-- and safety-compliance both forbid.
--
-- FIX CHOSEN (per this phase's own contract table, row 4: "the outcome is
-- AUTHORITATIVE on the attempt row: reconcile the job FROM it ... `failed`
-- -> the retry/terminal decision the result path would have made"): the
-- SQL function STOPS deciding a `failed` attempt's disposition. It now maps
-- `attempt_state = 'failed'` to `'needs_reconcile'` - the SAME terminal-
-- for-the-sweep status the `dispatched` branch already uses - so the row is
-- never silently retried and is visible (already-tested machinery: the
-- `wp_unresolved_jobs_total` honesty metric, the unresolved panel). The
-- app-level module (`app/backend/src/modules/queue/reaper.ts`, changed in
-- this same review round, NOT in this migration) then re-drives the
-- failure through the REAL `classify()` + the real per-tenant
-- terminal/retry/pause writes, inside `tenantDb.withTenant`, reusing
-- `result.ts`'s own routing logic rather than reimplementing it. A
-- `restricted`/`unknown` `error_class` therefore PAUSES THE INSTANCE
-- (`whatsapp_instances.health_state='paused'`) exactly as a live send
-- failure would - `wp_scheduler` already holds `UPDATE (health_state,
-- pause_reason, paused_at, needs_user_action)` on `whatsapp_instances`
-- (migration 0025, unchanged, sufficient - verified by inspection, no new
-- grant needed here).
--
-- Two additive columns are needed to let the app layer re-classify:
--   - `error_class` is projected through the `expired` CTE and the
--     RETURNING list (was silently discarded before - `grep error_class`
--     over 0027 returned nothing).
--   - `max_attempts` is projected likewise, so the app layer can run the
--     SAME `attemptNo >= maxAttempts` exhaustion arithmetic
--     `result-retry-budget.ts` already owns, instead of re-deriving it.
-- Both require a narrow, column-scoped `wp_reaper` SELECT grant addition
-- (never a table-level grant, never DELETE - see finding 1's rejected (b)
-- above for why a table-level/DELETE grant on send_attempts is off the
-- table for this role) - see section 0 below.
--
-- =====================================================================
-- FINDING 4 - `wp_reconcile_scan_unresolved`'s sibling-count subquery is
-- missing a `client_id` predicate
-- =====================================================================
--
-- MECHANISM: migration 0027's own header claims (verbatim) that this
-- function "reads no tenant identity to make ANY decision" - true for
-- `wp_reap_expired_leases`, but NOT true for this function's sibling-count
-- subquery (0027 lines ~405-413): it matches `sib.instance_id = a.instance_id
-- AND sib.content_hash = a.content_hash` with no `client_id` predicate, so
-- IF two different tenants' instances ever collide on `instance_id`
-- (instance_id is a global, cluster-wide UUID with no per-tenant partition
-- of the value space) AND happened to dispatch an attempt with the
-- identical `content_hash` inside the same tolerance window, the ambiguity
-- count computed for one tenant's row would silently include the OTHER
-- tenant's unrelated attempt - a cross-tenant read leaking into a
-- per-tenant AMBIGUITY DECISION (core invariant 4). Not practically
-- reachable today: `instance_id` values are `gen_random_uuid()`-derived
-- (effectively globally unique in practice), so no test can force an actual
-- collision, and none is added here for that reason (a test that cannot
-- fail proves nothing - `db/tests/reaper-repair-contract.test.ts`'s existing
-- `the_reconcile_scan_definer_is_read_only_and_single_pass_across_tenants`
-- already proves the OUTER query is correctly tenant-scoped; this fix
-- closes the one inner subquery that was not). Fixed anyway, on the same
-- fail-safe/defense-in-depth reasoning migration 0027 itself uses
-- elsewhere (deviation (c)): the predicate should be true regardless of
-- whether a collision is currently constructible, and it makes the
-- function's own header claim actually true rather than aspirational.
--
-- `wp_reconcile_scan_unresolved`'s signature and RETURN TABLE shape are
-- BOTH unchanged by this fix (one added `AND` clause inside an existing
-- subquery) - `CREATE OR REPLACE FUNCTION` is safe here (no DROP needed,
-- unlike function 1 above).
--
-- =====================================================================
-- CREATE OR REPLACE HARDENING RE-ASSERTION: OWNER/REVOKE/GRANT are
-- re-asserted explicitly below for BOTH functions (never assumed to
-- survive the DROP+CREATE / CREATE OR REPLACE respectively), exactly as
-- 0027 did, so the hardening posture is never implicit and a future diff
-- of this file alone proves the full picture without needing to
-- cross-reference 0027.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Additive wp_reaper grants - the columns the replaced function body
--    reads/writes. Narrowest possible: column-scoped only, on the same two
--    tables wp_reaper already touches (0027) - no new table, no new role,
--    no DELETE, no write grant of any kind on send_attempts (stays
--    SELECT-only there, unchanged from 0027).
--    - SELECT (error_class) / SELECT (max_attempts): finding 2's app-level
--      re-drive needs both projected through RETURNING (see that finding's
--      header above).
--    - UPDATE (failed_at, last_error_class): finding 1's follow-up
--      (exhausted 'prepared' branch going terminal, see the CASE
--      expression's own comment) - the SAME terminal shape
--      `result-retry-budget.ts#writeTerminalByExhaustion` writes for a real
--      exhausted RETRY_BACKOFF outcome, so this statement needs the same
--      two columns migration 0025 already granted wp_scheduler for that
--      exact purpose.
-- ---------------------------------------------------------------------
GRANT SELECT (error_class) ON send_attempts TO wp_reaper;
GRANT SELECT (max_attempts) ON message_jobs TO wp_reaper;
-- Both SELECT and UPDATE are required on failed_at/last_error_class: the
-- CASE expression's ELSE branch reads `j.failed_at`/`j.last_error_class`
-- (the "leave it unchanged" arm) in the SAME statement that writes them -
-- verified live (a UPDATE-only grant here throws "permission denied for
-- table message_jobs" on the ELSE branch's read, exactly the same shape
-- documented for terminal_at/sent_at in 0027's own SELECT list).
GRANT SELECT (failed_at, last_error_class) ON message_jobs TO wp_reaper;
GRANT UPDATE (failed_at, last_error_class) ON message_jobs TO wp_reaper;

-- ---------------------------------------------------------------------
-- 1. wp_reap_expired_leases(p_grace_seconds int, p_limit int) - REPLACED.
--    PARAMETER signature unchanged from 0027, but the RETURN TABLE shape
--    gains two columns (error_class, max_attempts) - Postgres refuses
--    `CREATE OR REPLACE FUNCTION` across a changed return type ("cannot
--    change return type of existing function", verified live), so this
--    migration DROPs the old signature first, then CREATEs the replacement
--    - both statements target the exact `(int, int)` signature, so no
--    other overload is touched. `DROP FUNCTION` does not run SECURITY
--    DEFINER body code and does not require special privilege beyond
--    ownership/superuser (this migration runs as wp_migrator, which owns
--    every DDL object in this schema - same role that ran 0027's CREATE).
--    EXECUTE grants are re-asserted fresh below regardless (never assumed
--    to survive a DROP).
-- ---------------------------------------------------------------------
DROP FUNCTION public.wp_reap_expired_leases(int, int);

CREATE FUNCTION public.wp_reap_expired_leases(p_grace_seconds int, p_limit int)
RETURNS TABLE (
  client_id                  uuid,
  instance_id                 uuid,
  message_job_id              bigint,
  message_job_created_at       timestamptz,
  new_status                  job_status,
  attempt_state                attempt_state,
  send_attempt_id               bigint,
  send_attempt_no                smallint,
  error_class                  text,
  max_attempts                 smallint
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'wp_reap_expired_leases: p_limit must be between 1 and 5000, got %', p_limit;
  END IF;
  IF p_grace_seconds IS NULL OR p_grace_seconds < 0 THEN
    RAISE EXCEPTION 'wp_reap_expired_leases: p_grace_seconds must be >= 0, got %', p_grace_seconds;
  END IF;

  RETURN QUERY
  WITH expired AS (
    SELECT j.id, j.created_at, j.client_id, j.instance_id, j.lease_id, j.max_attempts,
           a.id AS attempt_id, a.attempt_no, a.state AS attempt_state, a.resolved_at,
           a.error_class
      FROM public.message_jobs j
      LEFT JOIN public.send_attempts a
             ON a.message_job_id = j.id
            AND a.lease_id = j.lease_id
            -- FINDING 1 FOLLOW-UP #2 (caught live by this migration's own
            -- app-level repeated-cycle test): 0027's join ALSO required
            -- `a.message_job_created_at = j.created_at` ("partition-routing
            -- join, not a safety predicate" per its own comment) - but
            -- `send_attempts` is NOT partitioned (migration 0008's own
            -- header: "NOT partitioned ... so UNIQUE (message_job_id,
            -- attempt_no) is a real, global constraint"), so that equality
            -- was NEVER load-bearing for partition routing on THIS side of
            -- the join at all - it was pure dead weight inherited from the
            -- blueprint's canon statement. Worse: `dispatch.ts`'s
            -- `prepareAndIncrement` writes `send_attempts.message_job_
            -- created_at` from a caller-supplied JS `Date`
            -- (`input.jobCreatedAt`), which silently loses microsecond
            -- precision on every call (a PRE-EXISTING bug, present since
            -- P11, `dispatch.ts` itself out of THIS review's scope) - so
            -- this equality predicate silently failed for any job whose
            -- `created_at` was not exactly millisecond-aligned (i.e.
            -- almost every real job), making the reaper fall through to
            -- the no-attempt-row branch for a genuinely `prepared`/
            -- `dispatched`/`acked`/`failed` attempt from the SECOND
            -- dispatch() call onward. Verified live (see this migration's
            -- report): a `send_attempts` row with a millisecond-truncated
            -- `message_job_created_at` produced `attempt_state: null`
            -- despite `lease_id` matching exactly. DROPPED entirely -
            -- `a.lease_id = j.lease_id` ALONE is already a sufficient,
            -- MORE precise join key (lease_id is `gen_random_uuid()`,
            -- minted fresh on every single claim - claim-jobs.sql - so it
            -- is already globally unique per attempt lineage; the
            -- created_at equality added nothing beyond what lease_id
            -- alone already guaranteed). `message_job_created_at` stays in
            -- the SELECT/RETURNING list (callers still need it for their
            -- own delivery-event writes) - only the JOIN predicate is
            -- affected.
     WHERE j.status = 'processing'
       AND j.lease_expires_at < now() - make_interval(secs => p_grace_seconds)
       -- deviation (c) from 0027, unchanged: never claim a job whose matched
       -- attempt already reached a reconciler-owned terminal state - skip,
       -- do not re-process.
       AND (a.state IS NULL OR a.state NOT IN ('reconciled_sent', 'reconciled_lost', 'abandoned'))
     ORDER BY j.lease_expires_at
     LIMIT p_limit
     FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE public.message_jobs j
     -- Explicit ::job_status cast (0027 deviation, unchanged - required
     -- inside a plpgsql RETURN QUERY, see 0027's own comment for the
     -- verified 42804 error this avoids).
     SET status = (CASE
           -- FINDING 1 FOLLOW-UP (caught live by this migration's own
           -- mandatory test, repeated-cycle proof): once the 'prepared'
           -- branch stopped decrementing `attempts` (below), a job that
           -- crashes at 'prepared' on EVERY attempt (never once reaching
           -- the provider) can be reclaimed indefinitely - `claim-jobs.sql`
           -- has no `attempts < max_attempts` predicate by design (budget
           -- exhaustion is a result-time decision) - and the (N+1)th such
           -- cycle's `dispatch()` UPDATE hits `mj_attempts_range`'s CHECK
           -- (`attempts <= max_attempts + 1`, migration 0007) as a RAW,
           -- unhandled Postgres error instead of a clean terminal state.
           -- Same `attemptNo >= maxAttempts` exhaustion comparator
           -- `result-retry-budget.ts#isRetryBudgetExhausted` already owns
           -- (the attempt that just crashed IS `j.attempts`, since
           -- `prepareAndIncrement` already incremented it before the
           -- crash) - never re-derived, just mirrored in SQL because this
           -- statement has no result-write path to call into. Terminal,
           -- exactly like a real exhausted RETRY_BACKOFF outcome would be.
           WHEN e.attempt_state = 'prepared' AND j.attempts >= j.max_attempts THEN 'failed'
           WHEN e.attempt_state IS NULL OR e.attempt_state = 'prepared' THEN 'queued'        -- never dispatched
           WHEN e.attempt_state = 'dispatched'                          THEN 'needs_reconcile'
           WHEN e.attempt_state = 'acked'                               THEN 'sent'
           -- FINDING 2's fix: 'failed' no longer decided here - routed to
           -- needs_reconcile so the app-level classify() re-drive owns the
           -- terminal/retry/pause decision, never a blind flat-5s requeue.
           WHEN e.attempt_state = 'failed'                              THEN 'needs_reconcile'
           ELSE 'needs_reconcile' END)::job_status,
         -- FINDING 1's fix: the 'prepared' branch NO LONGER decrements
         -- `attempts` - it stays exactly as `dispatch()` last left it. See
         -- this migration's header for the full collision proof; the
         -- no-attempt-row branch (WHEN e.attempt_state IS NULL) is
         -- UNCHANGED from 0027 and still never touches `attempts` either
         -- (that branch's own history is the negative-counter bug canon
         -- already fixed once - not reopened here).
         attempts = j.attempts,
         sent_at  = CASE WHEN e.attempt_state = 'acked' THEN COALESCE(j.sent_at, e.resolved_at, now()) ELSE j.sent_at END,
         terminal_at = CASE WHEN e.attempt_state = 'acked'
                                 OR (e.attempt_state = 'prepared' AND j.attempts >= j.max_attempts)
                            THEN now() ELSE j.terminal_at END,
         failed_at = CASE WHEN e.attempt_state = 'prepared' AND j.attempts >= j.max_attempts
                          THEN now() ELSE j.failed_at END,
         last_error_class = CASE WHEN e.attempt_state = 'prepared' AND j.attempts >= j.max_attempts
                                 THEN 'prepared_crash_exhausted' ELSE j.last_error_class END,
         -- 'failed' dropped from this predicate (finding 2): a
         -- needs_reconcile job is not on a next_attempt_at-driven schedule
         -- at all - the app-level re-drive decides its own next_attempt_at
         -- (or pauses, or terminates) once it re-classifies. The exhausted
         -- 'prepared' branch is also excluded here - a terminal job does
         -- not get a next retry schedule either.
         next_attempt_at = CASE WHEN (e.attempt_state IS NULL OR e.attempt_state = 'prepared')
                                     AND NOT (e.attempt_state = 'prepared' AND j.attempts >= j.max_attempts)
                                THEN now() + interval '5 seconds' ELSE j.next_attempt_at END,
         lease_owner = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = now()
    FROM expired e
   -- deviation (b) from 0027, unchanged: `j.id = e.id` alone disambiguates
   -- (id is globally unique across every partition).
   WHERE j.id = e.id AND j.status = 'processing'
  RETURNING j.client_id, j.instance_id, j.id, j.created_at, j.status,
            e.attempt_state, e.attempt_id, e.attempt_no, e.error_class, e.max_attempts;
END;
$$;

ALTER FUNCTION public.wp_reap_expired_leases(int, int) OWNER TO wp_reaper;
REVOKE ALL ON FUNCTION public.wp_reap_expired_leases(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_reap_expired_leases(int, int) TO wp_scheduler;

-- ---------------------------------------------------------------------
-- 2. wp_reconcile_scan_unresolved(p_window_seconds int, p_tolerance_seconds
--    int, p_limit int) - REPLACED (finding 4). Signature and RETURN TABLE
--    both unchanged from 0027 - `CREATE OR REPLACE` is safe here. Every
--    line is identical to 0027's body except the single added
--    `AND sib.client_id = a.client_id` predicate inside the sibling-count
--    subquery (see this migration's FINDING 4 header above).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wp_reconcile_scan_unresolved(
  p_window_seconds int, p_tolerance_seconds int, p_limit int
)
RETURNS TABLE (
  client_id                  uuid,
  instance_id                 uuid,
  message_job_id              bigint,
  message_job_created_at       timestamptz,
  unresolved_at                timestamptz,
  send_attempt_id               bigint,
  send_attempt_no                smallint,
  content_hash                 bytea,
  dispatched_at                 timestamptz,
  sibling_inflight_count         int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'wp_reconcile_scan_unresolved: p_limit must be between 1 and 5000, got %', p_limit;
  END IF;
  IF p_window_seconds IS NULL OR p_window_seconds < 0 THEN
    RAISE EXCEPTION 'wp_reconcile_scan_unresolved: p_window_seconds must be >= 0, got %', p_window_seconds;
  END IF;
  IF p_tolerance_seconds IS NULL OR p_tolerance_seconds < 0 THEN
    RAISE EXCEPTION 'wp_reconcile_scan_unresolved: p_tolerance_seconds must be >= 0, got %', p_tolerance_seconds;
  END IF;

  RETURN QUERY
  SELECT j.client_id, j.instance_id, j.id, j.created_at, j.unresolved_at,
         a.id, a.attempt_no, a.content_hash, a.dispatched_at,
         (SELECT count(*)::int
            FROM public.send_attempts sib
           WHERE sib.instance_id = a.instance_id
             -- FINDING 4 fix: client_id added - the outer query is already
             -- correctly tenant-scoped (j.client_id drives the RETURNING
             -- row), but this inner sibling-count subquery previously
             -- matched on instance_id+content_hash alone, with no
             -- client_id predicate - see this migration's FINDING 4 header
             -- for the full mechanism.
             AND sib.client_id = a.client_id
             AND sib.content_hash = a.content_hash
             AND sib.state = 'dispatched'
             AND sib.id <> a.id
             AND sib.dispatched_at BETWEEN a.dispatched_at - make_interval(secs => p_tolerance_seconds)
                                        AND a.dispatched_at + make_interval(secs => p_tolerance_seconds)
         ) AS sibling_inflight_count
    FROM public.message_jobs j
    JOIN public.send_attempts a
      ON a.message_job_id = j.id
     AND a.state = 'dispatched'
     -- FINDING 1 FOLLOW-UP #2 (same fix as wp_reap_expired_leases above,
     -- see that join's own comment for the full mechanism): the
     -- `a.message_job_created_at = j.created_at` equality is DROPPED here
     -- too - `send_attempts` is not partitioned, so it was never a
     -- partition-routing necessity, and it silently broke this join for
     -- any job whose `created_at` lost microsecond precision through
     -- `dispatch.ts`'s JS-Date round trip. `a.message_job_id = j.id AND
     -- a.state = 'dispatched'` alone is already sufficient: only one
     -- `send_attempts` row can be in `state='dispatched'` for a given job
     -- at a time (the dispatch/result state machine never runs two
     -- attempts concurrently for the same job - `UNIQUE (message_job_id,
     -- attempt_no)`, migration 0008, plus the single-claim invariant).
   WHERE j.status = 'needs_reconcile'
     AND a.dispatched_at >= now() - make_interval(secs => p_window_seconds)
   ORDER BY a.dispatched_at
   LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.wp_reconcile_scan_unresolved(int, int, int) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_reconcile_scan_unresolved(int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_reconcile_scan_unresolved(int, int, int) TO wp_scheduler;
