-- pacing-ensure-ledger-row.sql (P13 Finding 5 fix, C1 review) - creates
-- today's `pacing_ledger` row (zero-valued) if it does not already exist
-- yet, run as a SEPARATE statement IMMEDIATELY BEFORE `reserve-pacing.sql`,
-- in the SAME transaction. Its sibling statement,
-- `db/queries/pacing-ensure-daily-usage-row.sql`, does the equivalent for
-- `client_daily_usage` - kept as a SEPARATE file/statement rather than
-- folded in here because this loader is single-statement-per-file (see
-- `db/src/queries.ts`'s own header, "one file, one statement"), same as
-- every other query file in this directory.
--
-- BIND PARAMETERS, in first-occurrence order (see db/src/queries.ts'
-- convertNamedParams - `$name` is converted to positional `$1..$n` in
-- first-occurrence order; loadQuery('pacing-ensure-ledger-row').paramNames
-- gives the authoritative list at runtime):
--   1. $instance_id  (uuid)
--   2. $client_id    (uuid)
--
-- WHY A SEPARATE STATEMENT (the MVCC snapshot rule, formerly documented in
-- `engine/pacing/index.ts`'s now-deleted FIRST_RESERVE_RETRY_REASONS
-- comment): every part of a single SQL statement - the main query plus
-- every CTE - shares ONE MVCC snapshot taken at statement start. A
-- data-modifying CTE's newly-inserted row is visible to a LATER part of the
-- SAME statement only when that later part references the CTE BY NAME; a
-- fresh base-table scan (what `reserve-pacing.sql`'s closing
-- `UPDATE pacing_ledger l ... FROM s, d` is) still sees the pre-statement
-- snapshot, i.e. no row at all, even if an earlier CTE in that SAME
-- statement just inserted it. `reserve-pacing.sql` used to fold this
-- row-creation into its own `ins`/`cu` CTEs, which meant the FIRST reserve
-- of every (instance, local day) ALWAYS spuriously denied once (see
-- `engine/pacing/index.ts`'s git history / this migration's sibling PR) -
-- `reserve()` then papered over it with a one-retry rule. Running the
-- INSERT as its OWN statement, immediately before, in the same transaction,
-- means its own commit-visible-to-later-statements semantics apply: by the
-- time `reserve-pacing.sql` runs (a brand NEW statement, fresh snapshot),
-- the row this statement just created IS visible on a plain base-table
-- scan. No retry needed, ever, for this reason.
--
-- NOT A SECOND GRANTOR: this statement creates ONLY zero-valued rows -
-- `consumed_count`/`sent_this_hour`/`new_conv_count`/`group_sent_count`/
-- `sent_count` are never referenced here at all (they default to 0 per
-- `db/migrations/0030_pacing.sql`'s CREATE TABLE), so
-- `scripts/check-single-reserve.ts`'s guard (which tracks writes to those
-- four `pacing_ledger` columns specifically) has nothing to flag in this
-- file. `reserve-pacing.sql` remains the ONLY statement that increments a
-- counter upward; `release-pacing.sql` remains the only one that decrements
-- one. This statement never increments anything.
--
-- FINDING 3 COMPOSITION (missing instance_pacing_state row): this INSERT is
-- driven `FROM instance_pacing_state s WHERE s.instance_id = $instance_id
-- AND s.client_id = $client_id` - when that row does not exist, `s` is
-- empty, so the SELECT source yields zero rows and this statement inserts
-- nothing (same for its sibling, pacing-ensure-daily-usage-row.sql).
-- `reserve-pacing.sql`'s own `s`/`d` CTEs then also see zero rows and its
-- closing UPDATE's `FROM s, d` yields zero rows (a normal deny), which
-- `pacing-deny-reason.sql` correctly classifies as `NO_LEDGER_ROW` - never a
-- NOT NULL violation, never a thrown error.
--
-- ON CONFLICT DO NOTHING: a concurrent reserve for the exact same
-- (instance, local day) racing this same ensure-statement is expected and
-- harmless - whichever commits first wins the row, the other is a no-op.
WITH s AS (
  SELECT pacing_timezone
    FROM instance_pacing_state
   WHERE instance_id = $instance_id AND client_id = $client_id
)
INSERT INTO pacing_ledger (client_id, instance_id, ledger_date, hour_key, next_eligible_at)
SELECT $client_id, $instance_id,
       (now() AT TIME ZONE s.pacing_timezone)::date,
       EXTRACT(hour FROM now() AT TIME ZONE s.pacing_timezone)::smallint,
       now()
  FROM s
ON CONFLICT (instance_id, ledger_date) DO NOTHING;
