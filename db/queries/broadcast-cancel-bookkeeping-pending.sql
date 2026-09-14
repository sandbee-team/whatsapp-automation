-- broadcast-cancel-bookkeeping-pending.sql (P23 C1 fix round, unit F1) -
-- cross-tenant discovery of `cancelled` campaigns that STILL have
-- bookkeeping work left, bounded and keyset-friendly (oldest `updated_at`
-- first). Deliberately narrower than `broadcast-campaigns-pending.sql`
-- (which is parametrised on status and used by the snapshot/expansion
-- sweeps for 'snapshotting'/'expanding'): that query has no notion of "is
-- there still work", so the cancel-bookkeeping sweep re-picked the SAME
-- oldest 20 cancelled campaigns forever, even after they were fully
-- stamped, starving a later-cancelled campaign whose inline bookkeeping
-- had crashed - the exact case this sweep exists for.
--
-- `runCancelBookkeepingBatch` stamps `campaign_recipients` to 'cancelled'
-- FIRST, then `message_jobs` to 'cancelled' SECOND, each its own
-- transaction - so a crash between the two loops can leave a campaign with
-- every recipient already terminal but a `queued` job still outstanding.
-- The EXISTS predicate below therefore covers BOTH sides (recipients
-- pending/queued OR a job still queued) so the campaign is never dropped
-- from discovery with work left on either side.
--
-- Answered by `cr_client_campaign_status_idx (client_id, campaign_id,
-- status)` for the recipients EXISTS and the partitioned
-- `message_jobs_claim_idx`-adjacent (client_id, instance_id, ...) shape is
-- not needed here (this EXISTS only needs `campaign_id`/`status`, answered
-- by the existing per-partition `(client_id, instance_id, ...)` index is
-- overkill; a plain campaign_id/status scan on the bounded per-campaign
-- row set is cheap - this query's own cost lives in `campaigns_worker_
-- discovery_idx`-style bound below) plus `campaigns_client_instance_status_
-- idx` is not required since this scans `campaigns` by its own `status`
-- column directly (no new index needed: the table is small and `status`
-- is already selective via the WHERE clause plus a bounded LIMIT).

-- name: broadcast-cancel-bookkeeping-pending
SELECT c.id, c.client_id
  FROM campaigns c
 WHERE c.status = 'cancelled'
   AND (
     EXISTS (
       SELECT 1 FROM campaign_recipients r
        WHERE r.client_id = c.client_id
          AND r.campaign_id = c.id
          AND r.status IN ('pending', 'queued')
     )
     OR EXISTS (
       SELECT 1 FROM message_jobs j
        WHERE j.client_id = c.client_id
          AND j.campaign_id = c.id
          AND j.status = 'queued'
     )
   )
 ORDER BY c.updated_at ASC
 LIMIT $limit;
