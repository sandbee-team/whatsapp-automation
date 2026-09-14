-- pacing-ensure-daily-usage-row.sql (P13 Finding 5 fix, C1 review) -
-- creates today's `client_daily_usage` row (zero-valued) if it does not
-- already exist yet, run as a SEPARATE statement IMMEDIATELY BEFORE
-- `reserve-pacing.sql`, in the SAME transaction, alongside its sibling
-- `db/queries/pacing-ensure-ledger-row.sql` (that file's own header has the
-- full MVCC-snapshot rationale for why this must be a separate statement
-- rather than a CTE folded into the reserve itself - identical reasoning
-- applies here for `client_daily_usage`, the plan-cap counter).
--
-- BIND PARAMETERS, in first-occurrence order (see db/src/queries.ts'
-- convertNamedParams - loadQuery('pacing-ensure-daily-usage-row')
-- .paramNames gives the authoritative list at runtime):
--   1. $instance_id  (uuid)
--   2. $client_id    (uuid)
--
-- NOT A SECOND GRANTOR: `sent_count` is inserted as a literal `0`, never
-- referenced or incremented here - this statement only ever creates a
-- zero-valued row. `reserve-pacing.sql`'s own closing UPDATE is the only
-- statement that increments `client_daily_usage.sent_count` (Finding 4
-- fix), and `scripts/check-single-reserve.ts`'s guard does not track
-- `sent_count` at all (it tracks only the four `pacing_ledger` counter
-- columns - see that guard's own header), so this file needs no exemption.
--
-- FINDING 3 COMPOSITION: driven `FROM instance_pacing_state s` exactly like
-- pacing-ensure-ledger-row.sql - a missing state row means `s` is empty and
-- this statement inserts nothing, composing with the fail-closed
-- NO_LEDGER_ROW deny path instead of a NOT NULL violation.
--
-- ON CONFLICT DO NOTHING: harmless under a concurrent race for the same
-- (client, local day) - whichever insert commits first wins.
WITH s AS (
  SELECT pacing_timezone
    FROM instance_pacing_state
   WHERE instance_id = $instance_id AND client_id = $client_id
)
INSERT INTO client_daily_usage (client_id, ledger_date, sent_count)
SELECT $client_id, (now() AT TIME ZONE s.pacing_timezone)::date, 0
  FROM s
ON CONFLICT (client_id, ledger_date) DO NOTHING;
