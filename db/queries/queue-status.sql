-- queue-status.sql (P19 Unit U5, step 9) - `GET /v1/queue-status`'s two
-- statements: per-instance rows and the workspace total. Both are
-- client_id-scoped (tenant isolation) - the caller runs both inside the
-- SAME `tenantDb.withTenant(clientId, ...)` transaction.
--
-- `waiting` uses the SAME bounded-probe idiom `instance-card-queue-depth.sql`
-- already established (`LIMIT 10001` inside the inner subquery, answered
-- by the existing `message_jobs_claim_idx` as an Index Only Scan) - never
-- an unbounded `count(*)` over a potentially large `queued` backlog.
--
-- `sent_today`/`failed_today`/`spent_today_minor` come from
-- `wallet_daily_summary` (PK `(client_id, day, instance_id)`,
-- migration 0051) - `day = current_date` (UTC, same boundary
-- `dashboard-summary.sql`'s own header documents for `client_daily_usage`).
-- `spent_today_minor` is `debit_minor - refund_minor` (net spend), never
-- just `debit_minor` alone (a same-day refund must reduce the figure the
-- tenant sees, not just internally reconcile later). NO OFFSET anywhere -
-- keyset pagination only, and this query never paginates at all (bounded to
-- a client's own live instance count, which this schema does not expect to
-- be large).

-- name: queue-status-per-instance
SELECT
  wi.id AS instance_id,
  (SELECT count(*) FROM (
     SELECT 1 FROM message_jobs
      WHERE client_id = $client_id AND instance_id = wi.id AND status = 'queued'
      LIMIT 10001
   ) t
  ) AS waiting,
  coalesce(s.sent_count, 0) AS sent_today,
  coalesce(f.failed_count, 0) AS failed_today,
  coalesce(s.debit_minor, 0) - coalesce(s.refund_minor, 0) AS spent_today_minor
  FROM whatsapp_instances wi
  LEFT JOIN wallet_daily_summary s
    ON s.client_id = wi.client_id AND s.instance_id = wi.id AND s.day = current_date
  LEFT JOIN (
    SELECT instance_id, count(*) AS failed_count
      FROM message_jobs
     WHERE client_id = $client_id AND status = 'failed' AND terminal_at >= current_date
     GROUP BY instance_id
  ) f ON f.instance_id = wi.id
 WHERE wi.client_id = $client_id AND wi.deleted_at IS NULL
 ORDER BY wi.id;

-- name: queue-status-workspace-totals
SELECT
  (SELECT count(*) FROM (
     SELECT 1 FROM message_jobs
      WHERE client_id = $client_id AND status = 'queued'
      LIMIT 10001
   ) t
  ) AS waiting,
  coalesce((SELECT sum(sent_count) FROM wallet_daily_summary
             WHERE client_id = $client_id AND day = current_date), 0) AS sent_today,
  (SELECT count(*) FROM message_jobs
    WHERE client_id = $client_id AND status = 'failed' AND terminal_at >= current_date
  ) AS failed_today,
  coalesce((SELECT sum(debit_minor) - sum(refund_minor) FROM wallet_daily_summary
             WHERE client_id = $client_id AND day = current_date), 0) AS spent_today_minor;
