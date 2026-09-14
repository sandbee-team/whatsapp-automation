-- instance-card-oldest-queued.sql (P17 Unit U4, step 7) - the card's
-- oldest-queued-age probe. Served by the partial index
-- `message_jobs_queued_probe_idx (client_id, instance_id, created_at)
-- WHERE status = 'queued'` (migration 0050; migration 0049's original
-- `message_jobs_queued_created_idx (instance_id, created_at)` omitted
-- client_id and could not answer this probe as an index-only scan - see
-- migration 0050's own header) as a pure forward Index Only Scan + Limit 1 -
-- see migration 0049's header, point 3, probe (b), for why the pre-existing
-- `message_jobs_recent_idx` could not answer this probe index-ordered for
-- the queued subset alone. `now()` in the age computation
-- is READ FROM POSTGRES by the caller (card.service.ts binds `serverNow`
-- from the SAME `now()` this query's sibling call reads - never Node's own
-- wall clock), per the "never local wall-clock arithmetic that ambient load
-- can perturb" rule.

-- name: instance-card-oldest-queued
SELECT MIN(created_at) AS oldest_queued_at, now() AS server_now
  FROM message_jobs
 WHERE client_id = $client_id
   AND instance_id = $instance_id
   AND status = 'queued';
