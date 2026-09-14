-- expansion-instance-queue-depth.sql (P23 Unit U4, step 5) - the expansion
-- worker's own bounded queue-depth backpressure probe. Same bounded-`LIMIT`
-- idiom as `instance-card-queue-depth.sql` (P17 U4): `LIMIT $limit_plus_one`
-- inside the inner subquery caps the row count the planner ever needs to
-- touch, so the outer `count(*)` never scans an unbounded 'queued' backlog.
-- Answered by the existing `message_jobs_claim_idx (client_id, instance_id,
-- priority_rank, next_attempt_at, id) WHERE status = 'queued'` as an
-- Index Only Scan - no new index needed. client_id = $client_id.

-- name: expansion-instance-queue-depth
SELECT count(*) AS queue_depth
  FROM (
    SELECT 1
      FROM message_jobs
     WHERE client_id = $client_id
       AND instance_id = $instance_id
       AND status = 'queued'
     LIMIT $limit_plus_one
  ) t;
