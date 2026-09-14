-- Fixture: shaped like the canonical claim (db/queries/claim-jobs.sql) - a
-- CTE with a `FOR UPDATE OF ... SKIP LOCKED` locking clause, followed by a
-- conditional `UPDATE ... SET ...` against that CTE. Must stay clean under
-- sql-lint: the `SET` here is the UPDATE statement's own assignment clause,
-- not a banned session-scoped SET, and `FOR UPDATE` must never be mistaken
-- for the bare UPDATE keyword.
WITH eligible AS (
  SELECT j.id, j.created_at
    FROM message_jobs j
   WHERE j.status = 'queued'
   ORDER BY j.next_attempt_at, j.id
   FOR UPDATE OF j SKIP LOCKED
   LIMIT 1)
UPDATE message_jobs j
   SET status = 'processing', updated_at = now()
  FROM eligible e
 WHERE j.id = e.id AND j.status = 'queued';
