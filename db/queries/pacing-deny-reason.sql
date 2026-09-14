-- pacing-deny-reason.sql (P13 Unit U3, step 5) - the cheap follow-up SELECT
-- run only after db/queries/reserve-pacing.sql returns zero rows.
--
-- BIND PARAMETERS: `loadQuery('pacing-deny-reason').paramNames` is the
-- AUTHORITATIVE, RUNTIME-VERIFIED bind order (`db/src/queries.ts`'s
-- `convertNamedParams`, first-occurrence order, comment/string-literal
-- aware as of the Finding 2 fix, P13 C1 review) - a `db/src/queries.test.ts`
-- test asserts it exactly; do NOT hand-maintain a second numbered copy of
-- this list. As of this revision the true order is: instance_id, client_id,
-- is_exempt, is_new_conversation, is_group.
-- RETURNING columns, in order: reason, retry_at.
--
-- EXEMPT LADDER (Finding 6, P14 review-fix F2): `reserve-pacing.sql`'s own
-- point (11) - an exempt reserve (`$is_exempt`) bypasses every pacing
-- predicate EXCEPT the sending window and the plan cap (see that file's
-- `granted` CTE WHERE clause: every non-window/non-plan-cap predicate is
-- `$is_exempt OR ...`). A follow-up denial classification for an exempt
-- attempt must therefore check ONLY those same two predicates, in the same
-- order reserve-pacing.sql itself does (window first) - checking MIN_GAP or
-- any of the other bypassed predicates for an exempt attempt would
-- misclassify a genuine exempt denial (e.g. reporting MIN_GAP for a send
-- that never even consults next_eligible_at) or, worse, fall through to
-- UNKNOWN and alert on an ordinary plan-cap exhaustion.
--
-- Names the reason a reserve attempt with the SAME bind values would have
-- been denied for, and computes retryAt. Returns exactly one row, always -
-- NO_LEDGER_ROW / UNKNOWN are themselves reasons, never an empty result
-- set, so the caller never has to special-case "no row at all".
--
-- ORDER MATTERS: the predicates below are evaluated with CASE/WHEN in the
-- EXACT SAME ORDER db/queries/reserve-pacing.sql's WHERE clause checks
-- them (sending window, next_eligible_at, daily cap, hourly cap,
-- new-conversation cap, cold-ratio floor/ratio, group daily cap, plan
-- cap), and returns the FIRST one that fails - so the reason the user sees
-- is the binding one, exactly the predicate that zeroed reserve-pacing's
-- result set.
--
-- OUTSIDE_WINDOW (P14 Unit U4): reserve-pacing.sql's `d.in_window`
-- predicate applies to EVERY reserve attempt, exempt or not (see that
-- file's own point (11) - exemption is from pacing, never from the
-- sending window). This statement must therefore check it too, ahead of
-- MIN_GAP, or a window-closed deny is misclassified (falls through every
-- later named predicate to UNKNOWN, which alerts - a nightly window close
-- is not a genuine contradiction worth paging on).
--
-- NO_LEDGER_ROW is a distinct, non-alerting reason: it fires only when
-- instance_pacing_state itself has no row for this instance/client (a
-- provisioning gap - see assertNoLiveInstanceIsMissingPacingState, the
-- boot gate that is supposed to make this state impossible in steady
-- state) OR reserve-pacing's own ON CONFLICT DO NOTHING first-send path
-- had not yet run for some external reason. It is called out separately
-- from UNKNOWN because a caller seeing NO_LEDGER_ROW should NOT alert -
-- it is an ordinary "first reserve for this instance today, ledger row
-- not visible yet in this read" race, not a bug.
--
-- UNKNOWN is fail-closed: every named predicate above was checked and
-- passed (i.e. this statement, run again, would not have denied), yet the
-- original reserve still returned zero rows - a genuine contradiction
-- (e.g. a concurrent second reserve raced ahead of this read, or a client
-- retried after the reserve's own transaction rolled back for an unrelated
-- reason). The caller holds 60s and alerts; UNKNOWN is never treated as a
-- grant.
--
-- READ-ONLY: this statement is a bare SELECT. It must never write a
-- counter - scripts/check-single-reserve.ts scans this file the same as
-- every other tracked file and would fail the build if it ever gained a
-- write to consumed_count/sent_this_hour/new_conv_count/group_sent_count.
WITH s AS (SELECT * FROM instance_pacing_state WHERE instance_id = $instance_id AND client_id = $client_id),
     d AS (SELECT (now() AT TIME ZONE (SELECT pacing_timezone FROM s))::date AS ledger_date,
                  EXTRACT(hour FROM now() AT TIME ZONE (SELECT pacing_timezone FROM s))::smallint AS hk,
                  (now() AT TIME ZONE (SELECT pacing_timezone FROM s))::time
                    BETWEEN (SELECT eff_window_start_local FROM s) AND (SELECT eff_window_end_local FROM s)
                    AS in_window
             FROM s),
     l AS (SELECT pl.* FROM pacing_ledger pl, d
            WHERE pl.client_id = $client_id AND pl.instance_id = $instance_id
              AND pl.ledger_date = d.ledger_date),
     u AS (SELECT cdu.sent_count,
                  (SELECT limit_value FROM effective_client_limits
                    WHERE client_id = $client_id AND limit_key = 'max_daily_sends') AS cap
             FROM client_daily_usage cdu, d
            WHERE cdu.client_id = $client_id AND cdu.ledger_date = d.ledger_date)
SELECT
  CASE
    WHEN (SELECT count(*) FROM s) = 0 OR (SELECT count(*) FROM l) = 0 THEN 'NO_LEDGER_ROW'
    WHEN NOT (SELECT in_window FROM d) THEN 'OUTSIDE_WINDOW'
    -- EXEMPT LADDER (Finding 6): every predicate below this point is
    -- bypassed for an exempt reserve (reserve-pacing.sql's own `$is_exempt
    -- OR ...` shape) - the ONLY remaining predicate an exempt attempt can
    -- still be denied by is the plan cap, checked directly next; anything
    -- else here would misclassify.
    WHEN $is_exempt AND (SELECT cap FROM u) IS NOT NULL AND (SELECT sent_count FROM u) >= (SELECT cap FROM u)
      THEN 'PLAN_CAP'
    WHEN $is_exempt THEN 'UNKNOWN'
    WHEN (SELECT next_eligible_at FROM l) > now() THEN 'MIN_GAP'
    WHEN (SELECT consumed_count FROM l) >= (SELECT eff_daily_cap FROM s) THEN 'DAILY_CAP'
    WHEN (CASE WHEN (SELECT hour_key FROM l) = (SELECT hk FROM d)
               THEN (SELECT sent_this_hour FROM l) ELSE 0 END) >= (SELECT eff_hourly_cap FROM s)
      THEN 'HOURLY_CAP'
    WHEN $is_new_conversation AND (SELECT new_conv_count FROM l) >= (SELECT eff_new_conv_cap FROM s)
      THEN 'NEW_CONV_CAP'
    WHEN $is_new_conversation
         AND (SELECT consumed_count FROM l) >= (SELECT eff_cold_ratio_floor FROM s)
         AND (SELECT new_conv_count FROM l) + 1 > (SELECT eff_cold_ratio_max FROM s) * ((SELECT consumed_count FROM l) + 1)
      THEN 'COLD_RATIO'
    WHEN $is_group AND (SELECT group_sent_count FROM l) >= (SELECT eff_group_daily_cap FROM s)
      THEN 'GROUP_DAILY_CAP'
    WHEN (SELECT cap FROM u) IS NOT NULL AND (SELECT sent_count FROM u) >= (SELECT cap FROM u)
      THEN 'PLAN_CAP'
    ELSE 'UNKNOWN'
  END AS reason,
  COALESCE((SELECT next_eligible_at FROM l), now()) AS retry_at;
