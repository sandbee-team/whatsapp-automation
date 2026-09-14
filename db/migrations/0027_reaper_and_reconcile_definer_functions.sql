-- P12 (queue-recovery-and-echo-spike) Unit U2a - migration 0027.
-- Unblocks the reaper (step 3) and the reconciler's read (step 6). Forward-
-- only, additive-only: no column dropped, no type changed, no existing
-- policy altered/dropped, no BYPASSRLS granted to wp_scheduler, no
-- `messages` table.
--
-- THE BLOCKER (verified live this session, twice): `message_jobs`,
-- `send_attempts`, `delivery_events` and `message_wa_ids` each carry exactly
-- ONE policy - `tenant_isolation`, PERMISSIVE, TO public, keyed on the
-- `app.client_id` GUC - under FORCE RLS. The reaper is a deliberately
-- cross-tenant batch (blueprint: `ORDER BY lease_expires_at LIMIT 500 FOR
-- UPDATE OF j SKIP LOCKED`, no client_id predicate - it must sweep every
-- tenant's expired leases in one pass) run as `wp_scheduler`, which is NOT
-- BYPASSRLS (db/tests/grants-snapshot.test.ts pins `rolbypassrls = false`).
-- With no `app.client_id` GUC set, `wp_scheduler` sees ZERO rows in every
-- one of those tables today - migration 0026 (P12 U1) only added COLUMN-level
-- grants, which control which columns a role may touch once RLS has already
-- admitted a row; they do nothing about the policy match itself.
--
-- REJECTED ALTERNATIVE 1 (must be stated, per this phase's own convention -
-- see 0018/0019's headers doing the same): a permissive `USING (true)`
-- policy `TO wp_scheduler` on each of these tables. Rejected because for a
-- system-wide sweep with no natural owner GUC to key on (unlike
-- `instance_lease_state`'s worker-scoped `lease_owner_renew_*` pair, which
-- has `app.worker_id` to key on), that shape is a spelled-out BYPASSRLS for
-- the role on every row of every tenant table it touches - it widens the
-- blast radius far beyond the two statements that actually need the
-- exemption, and it survives independently of whatever the reaper/reconciler
-- code actually calls. The definer-function route instead scopes the
-- exemption to exactly the two statements below.
--
-- PRECEDENT FOLLOWED, WITH ONE FOUNDER-APPROVED DEVIATION FOR THE WRITER:
-- this repo already solves the READ-ONLY half of this problem four times
-- over - `wp_lease_scan_unowned` (0018/0019), `wp_session_bootstrap_scan`
-- (0022), `wp_realtime_authz_snapshot` (0017), `wp_client_id_for_user`
-- (0015), `wp_zero_max_rate_wallet_count` (0005/0006) - every one of them
-- SELECT-only, owned by `wp_admin_app` (BYPASSRLS). `wp_reconcile_scan_
-- unresolved` below (function 2, STABLE, no UPDATE) follows that precedent
-- EXACTLY, unchanged: owned by `wp_admin_app`.
--
-- `wp_reap_expired_leases` (function 1) cannot: it is the first WRITING
-- cross-tenant definer function in this schema, and a SECURITY DEFINER
-- function's privilege checks - including plain table-level ACL grants, not
-- only RLS - run as the function's OWNER, not the caller. `wp_admin_app`
-- holds SELECT-only on `message_jobs` (a `SEND_PATH_TABLES` entry -
-- db/src/isolation/send-path-tables.ts) and must NEVER hold a write grant
-- there (db/tests/grants-snapshot.test.ts's `wp_admin_app_has_no_write_
-- grant_on_any_existing_send_path_table` enforces this - a staff-side write
-- to the send path is the forbidden staff-resume-without-the-provider's-
-- legitimate-path class, safety-compliance). Verified live before writing
-- this migration: `SET ROLE wp_admin_app; UPDATE message_jobs SET
-- updated_at = now() WHERE false;` -> `ERROR: permission denied for table
-- message_jobs`, even though wp_admin_app is BYPASSRLS - BYPASSRLS only
-- skips row-visibility policies, never the separate table-level ACL check.
--
-- REJECTED ALTERNATIVE 2: grant `wp_admin_app` UPDATE on `message_jobs`
-- (even column-scoped). Rejected outright - would silently convert a
-- deliberately staff-read-only role into a role that can rewrite send-path
-- state, defeating the exact invariant `wp_admin_app_has_no_write_grant_on_
-- any_existing_send_path_table` exists to pin. Not done; not weakened.
--
-- REJECTED ALTERNATIVE 3: `wp_migrator` as owner (it already holds full
-- table-level grants on every object, including UPDATE). Rejected - verified
-- live it is NOT BYPASSRLS, so as owner it just re-inherits the exact "zero
-- rows with no app.client_id GUC set" problem this function exists to solve:
-- `SET ROLE wp_migrator; SELECT count(*) FROM message_jobs;` -> `0`.
--
-- REJECTED ALTERNATIVE 4: `SET row_security = off` inside a `wp_migrator`-
-- owned definer function, instead of a BYPASSRLS owner. Rejected - verified
-- live it fails outright against a FORCE RLS table: `ERROR: query would be
-- affected by row-level security policy for table "message_jobs" / HINT: To
-- disable the policy for the table's owner, use ALTER TABLE NO FORCE ROW
-- LEVEL SECURITY.` FORCE RLS on message_jobs is deliberate (migration 0007)
-- and stays untouched.
--
-- REJECTED ALTERNATIVE 5: a per-tenant loop (iterate every client_id,
-- `tenantDb.withTenant` per tenant, run the reaper statement once per
-- tenant). Rejected - defeats the entire point of "sweep every tenant's
-- expired leases in one pass" (blueprint's reaper design and this migration's
-- own header above); at hundreds of tenants this is hundreds of round trips
-- every 15s on the reaper's own tick, and the `FOR UPDATE OF j SKIP LOCKED`
-- batch semantics (fair, contention-free draining across the whole table)
-- stop working the moment the scan is artificially partitioned by tenant.
--
-- FOUNDER-APPROVED RESOLUTION (decided 2026-09-01, after a live blocker
-- report against this exact migration): a FIFTH role, `wp_reaper` - NOLOGIN,
-- BYPASSRLS, whose ONLY purpose is to own `wp_reap_expired_leases`. Verified
-- end-to-end live before this migration was finalized (probe role + probe
-- definer function, both created then dropped - no `wp_probe%` artifact
-- remains in this database, confirmed by `db/tests/reaper-definer.test.ts`'s
-- `no_probe_artifacts_remain_from_the_role_design_spike` case):
--   CREATE ROLE wp_probe_reaper NOLOGIN BYPASSRLS;
--   GRANT USAGE ON SCHEMA public TO wp_probe_reaper;
--   GRANT SELECT, UPDATE ON message_jobs TO wp_probe_reaper;
--   GRANT SELECT ON send_attempts TO wp_probe_reaper;
--   -- definer owned by wp_probe_reaper, EXECUTE to wp_scheduler only
--   SET ROLE wp_scheduler; SELECT public.wp_probe_reap();
--   --> cross_tenant_rows_visible_and_update_ok=5 (all tenants visible, UPDATE succeeded)
--
-- WHY `wp_reaper` BEING BYPASSRLS IS NOT A TENANT-ISOLATION HOLE (core
-- invariant 4 - every future reader of this file must be able to answer
-- this from the file alone, without re-deriving it):
--   1. `wp_reaper` is NOLOGIN - nothing can ever connect to Postgres AS this
--      role from any application/network path; it exists purely to be an
--      OWNER, never a session identity. Pinned + tested (`db/tests/reaper-
--      definer.test.ts`'s `wp_reaper_cannot_log_in`).
--   2. The BYPASSRLS exemption is scoped to exactly the ONE statement this
--      role owns - `wp_reap_expired_leases`'s single UPDATE - never a
--      general-purpose escape hatch. `wp_reaper` holds no grant on any
--      OTHER table (tested: no grant on wallet_accounts,
--      whatsapp_session_credentials, auth_sessions, or anything outside
--      message_jobs/send_attempts), so even if some future caller could run
--      arbitrary SQL as `wp_reaper` (it cannot - NOLOGIN), there is nothing
--      else for it to read or write.
--   3. `EXECUTE` on the function itself is granted to `wp_scheduler` alone
--      (plus the owner, which always implicitly retains EXECUTE - Postgres
--      semantics, verified against every existing definer function in this
--      schema) - `REVOKE ALL ... FROM PUBLIC` first, same as every other
--      definer function here.
--   4. Placement-neutrality: the function reads no tenant identity to make
--      ANY decision - the WHERE clause is a lease-expiry/processing-state
--      guard alone; which row gets repaired and how depends only on
--      lease-expiry timing and the matched `send_attempts.state`, never on
--      which client_id a row belongs to. This is the same "no tenant-
--      conditional branching" property `scripts/check-placement-
--      neutrality.ts` guards elsewhere in this codebase - the cross-tenant
--      reach is real, but nothing it does is EVER conditioned on tenant
--      identity, so there is no lever here to favor/penalize one tenant.
--
-- `wp_admin_app`'s no-write-on-send-path invariant is fully intact and
-- UNTOUCHED by this migration: no new grant to wp_admin_app anywhere below,
-- SEND_PATH_TABLES is not edited, grants-snapshot.test.ts's `wp_admin_app_
-- has_no_write_grant_on_any_existing_send_path_table` is not weakened.
--
-- Both functions carry NO phone number, JID, or message body in any
-- parameter, return column, or log - ids and hashes only (`content_hash` is
-- bytea).
--
-- P18 (wallet/money seam) will consume `wp_reap_expired_leases`'s RETURNING
-- for the wallet charge on a repaired `acked` attempt
-- (`RepairedSendSink.onRepairedSent(attemptId)`), keyed on the returned
-- `send_attempts.id` - this is why that id is projected explicitly rather
-- than left for the caller to re-derive.

-- ---------------------------------------------------------------------
-- 0. wp_reaper role (cluster-level - guarded so re-running this migration,
--    or applying it against another database in the same cluster, never
--    double-creates the role - same idempotent shape as migration 0005's
--    four-role DO block). NOLOGIN (never a session identity - see the
--    tenant-isolation-hole rationale above), BYPASSRLS (required - see
--    REJECTED ALTERNATIVE 3/4 above for why nothing else works), never
--    granted to any other role, never used as a table owner for anything
--    other than this one function.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wp_reaper') THEN
    CREATE ROLE wp_reaper NOLOGIN;
  END IF;
END;
$$;

ALTER ROLE wp_reaper BYPASSRLS;

GRANT USAGE ON SCHEMA public TO wp_reaper;

-- Narrowest grant that makes wp_reap_expired_leases' actual statement work -
-- derived directly from that function's body below, not speculative:
--   message_jobs SELECT - every column the `expired` CTE and the UPDATE's
--     own SET-clause CASE expressions read: id/created_at/client_id/
--     instance_id/lease_id (join+identity), status/lease_expires_at (the
--     WHERE), attempts/sent_at/terminal_at/next_attempt_at/lease_owner (read
--     inside a CASE alongside the write, e.g. `GREATEST(0, j.attempts - 1)`,
--     `COALESCE(j.sent_at, ...)`).
--   message_jobs UPDATE, column-scoped to exactly the nine columns the SET
--     clause assigns - never a table-level UPDATE grant.
--   send_attempts SELECT only - the function never writes this table.
GRANT SELECT (
  id, created_at, client_id, instance_id, lease_id, status, lease_expires_at,
  attempts, sent_at, terminal_at, next_attempt_at, lease_owner
) ON message_jobs TO wp_reaper;

GRANT UPDATE (
  status, attempts, sent_at, terminal_at, next_attempt_at,
  lease_owner, lease_id, lease_expires_at, updated_at
) ON message_jobs TO wp_reaper;

GRANT SELECT (
  id, message_job_id, message_job_created_at, lease_id, attempt_no, state, resolved_at
) ON send_attempts TO wp_reaper;

-- ---------------------------------------------------------------------
-- 1. wp_reap_expired_leases(p_grace_seconds int, p_limit int) - VOLATILE
--    (it writes). LANGUAGE plpgsql, not sql: the mandatory input validation
--    below needs to RAISE on a bad parameter before the statement runs, and
--    a `sql`-language function has no RAISE. No dynamic SQL anywhere in the
--    body (both statements are static, parameters are ordinary bind
--    parameters) - so this is not an injection-surface widening, only a
--    validation-surface one.
--
--    Deviations from the blueprint's verbatim canon statement (each
--    verified; not "restored" back to canon - see this migration's own
--    review for why each is required):
--
--    a) `p_grace_seconds`/`p_limit` PARAMETERS instead of hardcoded
--       `interval '30 seconds'` / `LIMIT 500`, so @wp/domain's
--       `TIMING.reaperGraceMs` stays the single source of truth and tests
--       can drive the boundary without sleeping. Both are validated: a
--       non-positive limit, a limit above the 5000 ceiling, or a negative
--       grace all RAISE (fail closed, loudly - core invariant 2).
--
--    b) The final UPDATE's own copy of the job-identity/partition-routing
--       term is DROPPED (kept only in the CTE's own SELECT above, where it
--       has no equality-predicate role at all). See .memory/lessons/
--       2026-09-01-timestamptz-microseconds-vs-js-date-milliseconds.md:
--       `message_jobs.id` is `bigint GENERATED ALWAYS AS IDENTITY` and is
--       GLOBALLY unique across every partition (the partition key is only
--       needed to route an INSERT or let the planner prune, never to
--       disambiguate an id), so re-asserting it as a second equality
--       predicate in the final UPDATE buys nothing - it is dead weight this
--       function's own CTE join already keeps consistent (`e.id`/
--       `e.created_at` both come from the same `expired` CTE row) and a
--       trap for whoever later re-binds it through a JS Date and silently
--       gets zero rows. The two safety predicates that DO matter, `j.id =
--       e.id` and the job's own in-flight-state guard, are both kept below.
--
--    c) The `expired` CTE's LEFT JOIN additionally excludes any
--       `send_attempts` row whose `state` is already one of the THREE
--       reaper-OUTPUT / reconciler-terminal states - `reconciled_sent`,
--       `reconciled_lost`, `abandoned`. Those are what the reconciler (not
--       the reaper) writes once a `needs_reconcile` job's ambiguity is
--       resolved; a message_jobs row cannot legitimately still be in-flight
--       with an attempt already in one of those terminal states under this
--       system's normal write path, but a defensive exclusion here means a
--       corrupted/unexpected combination is simply never claimed by this
--       sweep (never silently re-processed through the generic `ELSE
--       'needs_reconcile'` branch) rather than mis-repaired. Fail-safe:
--       skip, do not guess.
--
--    d) The in-flight-state guard is NEVER written as a bind parameter -
--       every branch of the transition CASE below is a string literal
--       (verified: neither LITERAL_STATUS_PATTERN nor
--       PARAMETERIZED_STATUS_PATTERN in scripts/guards/single-claim-lib.ts
--       matches this statement, since it never assigns the claimed value at
--       all - this function only ever transitions jobs OUT of it, never
--       into it).
--
--    e) RETURNING projects exactly what the caller needs: `client_id`,
--       `instance_id`, the job identity tuple, the new status, the attempt
--       state that drove the decision, and the `send_attempts.id`/
--       `attempt_no` of that attempt (NULL when there was no attempt row -
--       the no-attempt-row repair branch). The `send_attempts.id` is
--       REQUIRED: P18's money seam is keyed on it, and `delivery_events`
--       needs the (job, attempt) pair to build its deterministic event id.
--
--    f) OWNER is `wp_reaper`, not `wp_admin_app` - see this file's header
--       for the full rationale (the first WRITING cross-tenant definer
--       function in this schema; `wp_admin_app` cannot legally hold the
--       UPDATE grant this statement needs without violating the send-path
--       write-grant invariant).
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_reap_expired_leases(p_grace_seconds int, p_limit int)
RETURNS TABLE (
  client_id                  uuid,
  instance_id                 uuid,
  message_job_id              bigint,
  message_job_created_at       timestamptz,
  new_status                  job_status,
  attempt_state                attempt_state,
  send_attempt_id               bigint,
  send_attempt_no                smallint
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
    SELECT j.id, j.created_at, j.client_id, j.instance_id, j.lease_id,
           a.id AS attempt_id, a.attempt_no, a.state AS attempt_state, a.resolved_at
      FROM public.message_jobs j
      LEFT JOIN public.send_attempts a
             ON a.message_job_id = j.id
            AND a.message_job_created_at = j.created_at -- partition-routing join, not a safety predicate
            AND a.lease_id = j.lease_id
     WHERE j.status = 'processing'
       AND j.lease_expires_at < now() - make_interval(secs => p_grace_seconds)
       -- deviation (c): never claim a job whose matched attempt already
       -- reached a reconciler-owned terminal state - skip, do not re-process.
       AND (a.state IS NULL OR a.state NOT IN ('reconciled_sent', 'reconciled_lost', 'abandoned'))
     ORDER BY j.lease_expires_at
     LIMIT p_limit
     FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE public.message_jobs j
     -- Explicit ::job_status cast (deviation from the blueprint's verbatim
     -- canon, required here specifically): a plain top-level UPDATE infers
     -- the CASE expression's target type from the assignment target, but
     -- this statement is prepared inside a plpgsql RETURN QUERY, where the
     -- CASE's branches (untyped string literals) default to `text` and the
     -- implicit text->job_status assignment cast is not applied - verified
     -- live (error 42804 "column status is of type job_status but
     -- expression is of type text") before adding this cast.
     SET status = (CASE
           WHEN e.attempt_state IS NULL OR e.attempt_state = 'prepared' THEN 'queued'        -- never dispatched
           WHEN e.attempt_state = 'dispatched'                          THEN 'needs_reconcile'
           WHEN e.attempt_state = 'acked'                               THEN 'sent'
           WHEN e.attempt_state = 'failed'                              THEN 'queued'
           ELSE 'needs_reconcile' END)::job_status,
         attempts = CASE WHEN e.attempt_state = 'prepared' THEN GREATEST(0, j.attempts - 1) ELSE j.attempts END,
         sent_at  = CASE WHEN e.attempt_state = 'acked' THEN COALESCE(j.sent_at, e.resolved_at, now()) ELSE j.sent_at END,
         terminal_at = CASE WHEN e.attempt_state = 'acked' THEN now() ELSE j.terminal_at END,
         next_attempt_at = CASE WHEN e.attempt_state IS NULL OR e.attempt_state IN ('prepared', 'failed')
                                THEN now() + interval '5 seconds' ELSE j.next_attempt_at END,
         lease_owner = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = now()
    FROM expired e
   -- deviation (b): `j.id = e.id` alone disambiguates (id is globally
   -- unique across every partition); the job's own in-flight-state guard
   -- below is what keeps this conditional, not blind (see deviation (d) -
   -- known guard false positive on this line, already being fixed
   -- elsewhere; the SQL itself is correct and unchanged for that reason).
   WHERE j.id = e.id AND j.status = 'processing'
  RETURNING j.client_id, j.instance_id, j.id, j.created_at, j.status,
            e.attempt_state, e.attempt_id, e.attempt_no;
END;
$$;

ALTER FUNCTION public.wp_reap_expired_leases(int, int) OWNER TO wp_reaper;
REVOKE ALL ON FUNCTION public.wp_reap_expired_leases(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_reap_expired_leases(int, int) TO wp_scheduler;

-- ---------------------------------------------------------------------
-- 2. wp_reconcile_scan_unresolved(p_window_seconds int, p_tolerance_seconds
--    int, p_limit int) - STABLE, read-only (no UPDATE anywhere in the body).
--    LANGUAGE plpgsql for the same reason as above: mandatory parameter
--    validation needs RAISE, which `sql`-language functions cannot do; no
--    dynamic SQL.
--
--    Cross-tenant READ ONLY: finds `needs_reconcile` jobs whose lease-expiry
--    repair (function 1 above) left them pending a human/reconciler decision,
--    together with their in-flight `send_attempts` evidence and the count of
--    OTHER in-flight attempts sharing the same content_hash within the
--    tolerance window (so the caller can apply the ">1 => resolve NONE"
--    ambiguity rule without a second cross-tenant query). The reconciler's
--    WRITES stay on the normal per-tenant RLS path (tenantDb.withTenant) -
--    this function is deliberately narrower than function 1: it never
--    mutates state, so it stays on the ORIGINAL precedent shape - owned by
--    `wp_admin_app` (BYPASSRLS), no new role, no new grant needed (its
--    default table-level SELECT on message_jobs/send_attempts already
--    covers everything this function reads).
--
--    p_window_seconds bounds how far back `send_attempts.dispatched_at` (the
--    in-flight attempt's own dispatch time) may be to still be considered a
--    live reconcile candidate - jobs/attempts older than this are the
--    72-simulated-hour no-auto-requeue boundary's concern, handled by the
--    caller reading `unresolved_at`, not by this scan. p_tolerance_seconds
--    is the ±window half-width used ONLY for the sibling-count aggregate
--    (matching evidence within `dispatched_at +/- tolerance`), never to
--    filter out the row itself - the caller decides what to do with an
--    ambiguous match, this function only reports the count.
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_reconcile_scan_unresolved(
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
             AND sib.content_hash = a.content_hash
             AND sib.state = 'dispatched'
             AND sib.id <> a.id
             AND sib.dispatched_at BETWEEN a.dispatched_at - make_interval(secs => p_tolerance_seconds)
                                        AND a.dispatched_at + make_interval(secs => p_tolerance_seconds)
         ) AS sibling_inflight_count
    FROM public.message_jobs j
    JOIN public.send_attempts a
      ON a.message_job_id = j.id
     AND a.message_job_created_at = j.created_at -- partition-routing join, not a safety predicate
     AND a.state = 'dispatched'
   WHERE j.status = 'needs_reconcile'
     AND a.dispatched_at >= now() - make_interval(secs => p_window_seconds)
   ORDER BY a.dispatched_at
   LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.wp_reconcile_scan_unresolved(int, int, int) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_reconcile_scan_unresolved(int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_reconcile_scan_unresolved(int, int, int) TO wp_scheduler;
