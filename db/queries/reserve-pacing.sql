-- reserve-pacing.sql (P13 Unit U3, step 5; rewritten P13 C1 review
-- Findings 3/4/5) - the canonical pacing grant.
--
-- BIND PARAMETERS: `loadQuery('reserve-pacing').paramNames` is the
-- AUTHORITATIVE, RUNTIME-VERIFIED list (`db/src/queries.ts`'s
-- `convertNamedParams`, first-occurrence order, comment/string-literal
-- aware as of the Finding 2 fix below) - a `db/src/queries.test.ts` test
-- asserts it exactly; do NOT hand-maintain a second numbered copy of this
-- list here (that is exactly how Finding 2, C1 review, went stale - the
-- numbered list below was already wrong even after stripping comments,
-- because nobody re-derived it after the file changed). As of this
-- revision the true order is: instance_id, client_id, is_exempt,
-- is_new_conversation, is_group, gap_ms.
-- RETURNING columns, in order: consumed_count, sent_this_hour,
-- new_conv_count, group_sent_count, next_eligible_at, ledger_date.
--
-- (1) This is the ONLY statement in the system allowed to consume a pacing
--     unit - i.e. to write pacing_ledger.consumed_count, sent_this_hour,
--     new_conv_count or group_sent_count upward - enforced by
--     scripts/check-single-reserve.ts, which fails the build if any other
--     scanned file writes one of those four columns via a raw SQL or
--     TS/TSX string/template-literal UPDATE ... SET ..., the same shape
--     with the literal bound as a query parameter instead, or the Drizzle
--     ORM update(...).set({...}) equivalent. db/queries/release-pacing.sql
--     is the one sanctioned exception (it decrements the same four columns
--     as a post-commit refund - see that file's own header).
--
-- (2) Limits are read IN-STATEMENT from instance_pacing_state, never from a
--     worker cache. A worker-side limits cache in the grant path
--     re-creates Blastup's TOCTOU race. The only cache allowed anywhere is
--     the 30 s display/config cache, and it is never an input to this
--     WHERE.
--
-- (3) ledger_date and hour_key are computed INSIDE the statement from
--     instance_pacing_state.pacing_timezone - never in Node, never from
--     now()::date. Timezone cannot be used to reset a cap.
--
-- (4) The wallet balance is deliberately NOT checked here (ADR 0019 §4).
--     The two balance predicates live in db/queries/claim-jobs.sql. Putting
--     them here mixes two authorities in one statement and makes blueprint
--     test 22's intent unenforceable. If a reviewer asks "shouldn't the
--     balance be checked before we consume a unit?" - no, the claim already
--     refused.
--
-- (5) is_new_conversation is false for group sends (scope delta). Counting
--     a group send as a cold DM corrupts the cold-ratio measurement, which
--     is one of the three signals P16 actually scores. Callers must pass
--     $is_new_conversation = false whenever $is_group = true; this
--     statement does not derive one from the other because doing so here
--     would be a second, hidden authority over what counts as a "new
--     conversation" - the caller decides, once, before binding.
--
-- (6) Zero rows = deny, and that is a normal outcome.
--     db/queries/pacing-deny-reason.sql names the reason.
--
-- (7) A group send consumes 1 unit against consumed_count plus 1 against
--     group_sent_count - the socket sends one message; the risk is reach,
--     so reach gets its own much smaller cap.
--
-- (8) FINDING 5 FIX (P13 C1 review): the FIRST-RESERVE-OF-THE-DAY row
--     creation (formerly this statement's own `ins`/`cu` CTEs) is GONE.
--     Every part of one SQL statement (main query + every CTE) shares ONE
--     MVCC snapshot taken at statement start - a data-modifying CTE's
--     newly-inserted row is visible to a LATER part of the SAME statement
--     only when that later part references the CTE BY NAME; the closing
--     UPDATE below scans the BASE `pacing_ledger`/`client_daily_usage`
--     tables directly, so it could never see a row an in-statement `ins`/
--     `cu` CTE had just inserted moments earlier - meaning the very first
--     reserve for every (instance, local day) ALWAYS spuriously denied
--     once, papered over by a one-retry rule in `engine/pacing/index.ts`
--     (now deleted). Row creation is now
--     `db/queries/pacing-ensure-ledger-row.sql` +
--     `db/queries/pacing-ensure-daily-usage-row.sql`, run as separate
--     statements immediately before this one, in the same transaction (see
--     either file's own header for the full rationale) - by the time THIS
--     statement runs, both rows are visible on an ordinary base-table scan,
--     no retry needed. Callers that skip the ensure statements when
--     `instance_pacing_state` has no row (Finding 3, see point (9) below)
--     are fine: this statement's own `s`/`d` CTEs then see zero rows too,
--     and the whole thing is a normal zero-row deny.
--
-- (9) FINDING 3 FIX (P13 C2 hardening): this statement no longer creates
--     ANY row itself (see point (8)) - `s`/`d`/`u` are all plain read-only
--     CTEs now, so a missing `instance_pacing_state` row simply makes `s`
--     (and therefore `d`) empty, and the closing UPDATE's `FROM s, d`
--     yields zero rows - a normal deny, never a NOT NULL violation.
--     `pacing-deny-reason.sql` (also read-only, unaffected by this file's
--     change) classifies that shape as `NO_LEDGER_ROW`.
--
-- (10) FINDING 4 FIX (P13 C1 review): `client_daily_usage.sent_count` is
--     now genuinely enforced AND incremented, only on a real GRANT. `u` is
--     a LEFT JOIN (was an inner FROM-item before this fix - a MISSING
--     `client_daily_usage` row used to zero the whole UPDATE, a second,
--     independent cause of a spurious first-reserve deny, now fixed by the
--     ensure-statement in point (8) plus this LEFT JOIN belt-and-braces).
--     The increment itself cannot live inside this statement's own SET
--     list without breaking atomicity or the single-grantor rule (the
--     closing UPDATE's WHERE clause IS the grant decision - anything in
--     its SET list would run unconditionally against whatever row FROM
--     matched, before the WHERE has decided grant-vs-deny), so it is a
--     SEPARATE UPDATE, chained via a CTE (`granted`) that only produces a
--     row when the pacing_ledger UPDATE itself produced one - i.e. only on
--     a real grant, never on every attempt. This is still ONE statement,
--     ONE transaction, atomic: either both updates commit (a grant) or
--     neither does (a deny/rollback).
--
-- (11) P14 Unit U4: `$is_exempt` - true for the two pacing-exempt
--     `SendOrigin`s (`system_reply`/`opt_out_confirmation`,
--     `isExemptOrigin()` in `@wp/domain`), bound by the caller
--     (`engine/pacing/index.ts#reserve`). An exempt reserve bypasses the
--     min-gap/daily-cap/hourly-cap/new-conv-cap/cold-ratio/group-daily-cap
--     predicates entirely (a system-generated send is not tenant traffic
--     subject to those caps) but KEEPS the sending-window predicate below -
--     a 03:00 exempt send still defers to window open (a human still should
--     not receive it at 3am, exemption is from PACING, not from the
--     window). It consumes NO regular unit and does NOT advance
--     `next_eligible_at` (an exempt send never consumes the gap a tenant
--     send would otherwise wait on) - instead it increments the separate
--     `pacing_ledger.system_count` counter (evidence-only, untracked by
--     `check-single-reserve.ts`'s four-column ban) via its own UPDATE
--     branch. The plan-cap predicate (`u.cap`) and its `usage_bump` are
--     UNCHANGED for an exempt grant - deliberately not in the task's
--     bypass list, and a client-wide plan cap is a billing concern
--     orthogonal to per-instance pacing.
WITH s AS (
       SELECT * FROM instance_pacing_state WHERE instance_id = $instance_id AND client_id = $client_id
     ),
     d AS (
       SELECT (now() AT TIME ZONE s.pacing_timezone)::date AS ledger_date,
              EXTRACT(hour FROM now() AT TIME ZONE s.pacing_timezone)::smallint AS hk,
              (now() AT TIME ZONE s.pacing_timezone)::time
                BETWEEN s.eff_window_start_local AND s.eff_window_end_local AS in_window
         FROM s
     ),
     u AS (
       SELECT cdu.sent_count,
              (SELECT limit_value FROM effective_client_limits
                WHERE client_id = $client_id AND limit_key = 'max_daily_sends') AS cap
         FROM client_daily_usage cdu, d
        WHERE cdu.client_id = $client_id AND cdu.ledger_date = d.ledger_date
     ),
     granted AS (
       UPDATE pacing_ledger l
          SET consumed_count   = l.consumed_count + (NOT $is_exempt)::int,
              sent_this_hour   = CASE
                                    WHEN $is_exempt THEN l.sent_this_hour
                                    WHEN l.hour_key = (SELECT hk FROM d) THEN l.sent_this_hour + 1
                                    ELSE 1
                                  END,
              hour_key         = CASE WHEN $is_exempt THEN l.hour_key ELSE (SELECT hk FROM d) END,
              new_conv_count   = l.new_conv_count + (CASE WHEN $is_exempt THEN 0 ELSE ($is_new_conversation)::int END),
              group_sent_count = l.group_sent_count + (CASE WHEN $is_exempt THEN 0 ELSE ($is_group)::int END),
              system_count     = l.system_count + ($is_exempt)::int,
              last_reserved_at = now(),
              -- An exempt grant never advances next_eligible_at - it consumes
              -- no gap (point 11 above).
              next_eligible_at = CASE
                                    WHEN $is_exempt THEN l.next_eligible_at
                                    ELSE now() + ($gap_ms || ' milliseconds')::interval
                                  END,
              updated_at       = now()
         FROM s, d
              LEFT JOIN u ON true
        WHERE l.client_id = $client_id AND l.instance_id = $instance_id AND l.ledger_date = d.ledger_date
          AND d.in_window                                                            -- sending window (both paths)
          AND ($is_exempt OR l.next_eligible_at <= now())                            -- min gap
          AND ($is_exempt OR l.consumed_count < s.eff_daily_cap)                     -- daily cap
          AND ($is_exempt OR (CASE WHEN l.hour_key = d.hk THEN l.sent_this_hour ELSE 0 END) < s.eff_hourly_cap)   -- hourly cap
          AND ($is_exempt OR NOT $is_new_conversation OR l.new_conv_count < s.eff_new_conv_cap)    -- cold-outreach cap
          AND ($is_exempt OR NOT $is_new_conversation OR l.consumed_count < s.eff_cold_ratio_floor
               OR (l.new_conv_count + 1)::numeric <= s.eff_cold_ratio_max * (l.consumed_count + 1)::numeric)
          AND ($is_exempt OR NOT $is_group OR l.group_sent_count < s.eff_group_daily_cap)          -- group daily cap
          AND (u.cap IS NULL OR u.sent_count < u.cap)                                -- plan cap (both paths)
       RETURNING l.consumed_count, l.sent_this_hour, l.new_conv_count, l.group_sent_count,
                 l.next_eligible_at, d.ledger_date
     ),
     usage_bump AS (
       UPDATE client_daily_usage cdu
          SET sent_count = cdu.sent_count + 1
         FROM granted g
        WHERE cdu.client_id = $client_id AND cdu.ledger_date = g.ledger_date
       RETURNING 1
     )
-- WHAT GATES `usage_bump` (read this before editing it): a data-modifying
-- statement in WITH is executed EXACTLY ONCE, UNCONDITIONALLY, whether or
-- not the primary query references its output (Postgres docs; verified
-- against live PG 17 - an unreferenced `WITH bump AS (UPDATE ...)` DOES
-- run). So the LEFT JOIN below is NOT what makes this UPDATE happen.
-- What makes it conditional is its own FROM: `usage_bump` reads
-- `FROM granted g`, and `granted` is empty on a denial (its conditional
-- UPDATE matched no row), so the join finds nothing and zero rows are
-- updated. DATA FLOW is the gate, never reference from the final SELECT -
-- edit `FROM granted g` and you silently start counting denied attempts
-- against the tenant's plan usage. The LEFT JOIN is kept only so this
-- side-effect CTE's row count can never suppress the caller-visible
-- RETURNING row. See .memory/lessons/2026-09-02-pacing-c1-review-fixes.md.
SELECT g.consumed_count, g.sent_this_hour, g.new_conv_count, g.group_sent_count,
       g.next_eligible_at, g.ledger_date
  FROM granted g
  LEFT JOIN usage_bump ub ON true;
