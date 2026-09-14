-- broadcast-campaigns-pending.sql (P23 Unit U4, step 4/5 cron discovery) -
-- cross-tenant discovery of campaigns sitting in a given status (either
-- 'snapshotting' or 'expanding'), oldest `updated_at` first, bounded. Answered
-- by `campaigns_worker_discovery_idx ON campaigns (status, updated_at) WHERE
-- status IN ('snapshotting', 'expanding')` (migration 0064) - deliberately
-- cross-tenant (no client_id predicate), same class as
-- `contact-imports-pending-clients.sql`.

-- name: broadcast-campaigns-pending
SELECT id, client_id
  FROM campaigns
 WHERE status = $status
 ORDER BY updated_at ASC
 LIMIT $limit;
