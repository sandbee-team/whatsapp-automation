-- Fixture (P12 Unit U5) - a FOR UPDATE SKIP LOCKED row-lock clause on a
-- claim-style CTE, immediately followed by an UPDATE that changes a job's
-- status but NEVER moves it out of 'blocked_needs_review' (it moves it
-- OUT of 'queued' instead, an unrelated transition). Must NOT be flagged -
-- the row-lock clause's own "UPDATE" token must not seed a phantom match,
-- and this statement's real SET/WHERE pair never touches
-- 'blocked_needs_review' at all.
WITH candidate AS (
  SELECT id FROM message_jobs
   WHERE status = 'queued'
   ORDER BY created_at
   FOR UPDATE SKIP LOCKED
)
UPDATE message_jobs
   SET status = 'processing'
 WHERE id IN (SELECT id FROM candidate) AND status = 'queued';
