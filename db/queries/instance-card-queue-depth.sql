-- instance-card-queue-depth.sql (P17 Unit U4, step 7) - the card's bounded
-- queue-depth probe. `LIMIT 10001` inside the inner subquery caps the row
-- count the planner ever needs to touch: the outer `count(*)` reports at
-- most 10001, and card.service.ts renders exactly 10000 with
-- `queueDepthCapped: true` whenever the raw count reaches that ceiling -
-- never an unbounded `count(*)` over a potentially 10,000+-row backlog.
-- Answered by the existing `message_jobs_claim_idx (client_id, instance_id,
-- priority_rank, next_attempt_at, id) WHERE status = 'queued'` as an
-- Index Only Scan - see migration 0049's own header, point 3, probe (a):
-- no new index needed for this probe. `client_id` is bound explicitly
-- (never cross-tenant - this is a per-instance, per-client read like every
-- other query in this file).

-- name: instance-card-queue-depth
SELECT count(*) AS queue_depth
  FROM (
    SELECT 1
      FROM message_jobs
     WHERE client_id = $client_id
       AND instance_id = $instance_id
       AND status = 'queued'
     LIMIT 10001
  ) t;
