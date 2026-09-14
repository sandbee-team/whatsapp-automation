-- P23a (broadcast-funnel-recompute) C1 fix round Unit F1 - migration 0065.
-- Reviewer finding (MAJOR): `db/queries/broadcast-funnel-pending.sql` section
-- `funnel-active` scans `campaigns WHERE status IN ('snapshotting',
-- 'expanding', 'running', 'paused') ORDER BY updated_at ASC LIMIT $limit`
-- every 5 seconds fleet-wide with no supporting index -
-- `campaigns_worker_discovery_idx` (migration 0064) is partial on
-- `('snapshotting', 'expanding')` only and cannot serve `running`/`paused`.
-- A parallel unit changes that query to a KEYSET ROTATION by primary key:
-- `WHERE status IN ('snapshotting', 'expanding', 'running', 'paused')
--   AND id > $cursor ORDER BY id LIMIT $limit` (wrapping to the start when
-- short). This index answers that shape directly (leading column `id`,
-- partial on the four in-flight statuses).
--
-- Deliberately global (does NOT lead with client_id), same class as
-- `campaigns_worker_discovery_idx` (migration 0064) and
-- `message_jobs_lease_expiry_idx`/`ils_stale_idx`: this is a cross-tenant
-- worker discovery sweep, not a tenant-scoped query.

CREATE INDEX campaigns_funnel_discovery_idx
  ON campaigns (id)
  WHERE status IN ('snapshotting', 'expanding', 'running', 'paused');
