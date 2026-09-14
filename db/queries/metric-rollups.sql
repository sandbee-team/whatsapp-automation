-- metric-rollups.sql (P25 observability-and-runbook, Unit U3) - two
-- named sections, both cross-tenant (registered in
-- scripts/registries/cross-tenant-queries.ts / cross-tenant-queries-p25.ts
-- under this file's own keys).

-- name: metric-rollup-fleet
-- ONE statement, no top-level FROM, five `(SELECT count(*)::int FROM ...)`
-- scalar subqueries - the exact fleet-gauges.sql shape that
-- check-scheduler-queries' isInherentlySingleRow rule accepts (a SELECT with
-- no top-level FROM always returns exactly one row).
--
-- messages_out_without_job: `direction = 'out' AND message_id IS NULL AND
-- observed_at IS NULL`. `observed_at IS NULL` matters -
-- modules/queue/echo-capture.ts legitimately inserts `direction='out'` echo-
-- evidence rows with `message_id NULL` and `observed_at = now()` (a message
-- sent from the phone itself, or an echo awaiting reconciliation) - those
-- are NOT invariant-1 violations. The send path (engine/queue/result.ts)
-- always writes `message_id`, so this count is 0 unless a bypass writer
-- exists. Served by the partial index message_wa_ids_evidence_idx
-- (WHERE message_id IS NULL, migration 0026).
--
-- jobs_blocked_needs_review / jobs_needs_reconcile: both served by the
-- existing partial index message_jobs_review_idx (WHERE status IN
-- ('needs_reconcile','blocked_needs_review'), migration 0007).
--
-- instances_connected / instances_desired_online: `desired_state = 'online'
-- AND deleted_at IS NULL`, the latter without the health_state predicate -
-- byte-identical to fleet-gauges.sql's desired_online_count predicate
-- (the session-availability SLO denominator).
SELECT
  (
    SELECT count(*)::int
      FROM message_wa_ids
     WHERE direction = 'out'
       AND message_id IS NULL
       AND observed_at IS NULL
  ) AS messages_out_without_job,
  (
    SELECT count(*)::int
      FROM message_jobs
     WHERE status = 'blocked_needs_review'
  ) AS jobs_blocked_needs_review,
  (
    SELECT count(*)::int
      FROM message_jobs
     WHERE status = 'needs_reconcile'
  ) AS jobs_needs_reconcile,
  (
    SELECT count(*)::int
      FROM whatsapp_instances
     WHERE desired_state = 'online'
       AND deleted_at IS NULL
       AND health_state = 'connected'
  ) AS instances_connected,
  (
    SELECT count(*)::int
      FROM whatsapp_instances
     WHERE desired_state = 'online'
       AND deleted_at IS NULL
  ) AS instances_desired_online;

-- name: optout-rate-flagged-clients
-- Set-based, one statement, driven from the SMALL table (opt_outs). EVERY
-- client with an opt-out in the 24h window is evaluated - the CTE has no
-- LIMIT of its own, so a client is never dropped from consideration by
-- client_id ordering. The bound applies only to the FLAGGED set (the
-- output), never to which clients get checked: LIMIT sits in the outer
-- statement, after the rate predicate, ordered by rate descending so the
-- worst offenders are the ones kept when the flagged set exceeds $limit.
--
-- The per-client acked-send count is a correlated scalar subquery over
-- message_jobs that partition-prunes on created_at and uses
-- message_jobs_recent_idx (client_id, instance_id, created_at DESC, id
-- DESC) - it runs once per client that has an opt-out in the window
-- (O(clients-with-optouts) per HOURLY tick; ADR 0018 S4 permits this -
-- slower than 5 minutes, never per instance). Deliberately never touches
-- send_attempts (hot write path) - no new index, no scan there.
--
-- sent_at/status='sent' is the durable "acked" fact on the job row;
-- created_at >= now() - 2 days is there for partition pruning only (the
-- real 24h window is the sent_at predicate). check-scheduler-queries'
-- hasLimitClause (a plain "does this file's text contain LIMIT" scan)
-- still sees the LIMIT regardless of it now being in the outer statement.
WITH recent_optouts AS (
  SELECT client_id, count(*)::int AS optouts
    FROM opt_outs
   WHERE created_at >= now() - interval '24 hours' AND restored_at IS NULL
   GROUP BY client_id
), rated AS (
  SELECT o.client_id, o.optouts,
         (SELECT count(*)::int FROM message_jobs j
           WHERE j.client_id = o.client_id
             AND j.status = 'sent'
             AND j.created_at >= now() - interval '2 days'
             AND j.sent_at >= now() - interval '24 hours') AS acked_sends
    FROM recent_optouts o
)
SELECT client_id, acked_sends, optouts
  FROM rated
 WHERE acked_sends >= $min_sends AND optouts * 1000 > $per_thousand * acked_sends
 ORDER BY (optouts::numeric / acked_sends) DESC, client_id
 LIMIT $limit;
