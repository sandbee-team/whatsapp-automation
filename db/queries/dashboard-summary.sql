-- dashboard-summary.sql (P17 Unit U4 carried item) - `GET /v1/dashboard/
-- summary`'s three numbers, one client-scoped statement: connected-number
-- count (`whatsapp_instances.health_state = 'connected'`), a BOUNDED
-- (`LIMIT 10001`) queued-job count (same bounded-probe idiom as
-- `instance-card-queue-depth.sql`, just without the per-instance filter),
-- and today's sent count read from the SAME stored `client_daily_usage`
-- counter `reserve-pacing.sql`'s own closing UPDATE maintains - never a
-- `count(*)` over `message_jobs` for the sent figure. `ledger_date` here is
-- resolved from `now()::date` directly (UTC) rather than a per-instance
-- local timezone: `client_daily_usage` is a CLIENT-level rollup with no
-- per-instance timezone of its own (see `db/schema/client-daily-usage.ts`) -
-- the same UTC boundary `reserve-pacing.sql`'s `usage_bump` CTE writes
-- against (it derives `ledger_date` from whichever instance's OWN local day
-- triggered the write, so this read intentionally accepts a day-boundary
-- looseness at UTC midnight rather than picking one arbitrary instance's
-- timezone to re-derive it for a client-wide summary).

-- name: dashboard-summary
SELECT
  (SELECT count(*) FROM whatsapp_instances
    WHERE client_id = $client_id AND health_state = 'connected' AND deleted_at IS NULL
  ) AS connected_numbers,
  (SELECT count(*) FROM (
     SELECT 1 FROM message_jobs
      WHERE client_id = $client_id AND status = 'queued'
      LIMIT 10001
   ) t
  ) AS queued,
  (SELECT sent_count FROM client_daily_usage
    WHERE client_id = $client_id AND ledger_date = now()::date
  ) AS sent;
