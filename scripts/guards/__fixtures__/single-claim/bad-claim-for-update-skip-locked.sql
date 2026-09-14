-- Fixture (P12, 2026-09-01): proves the FOR UPDATE fix did not open a hole -
-- a `FOR UPDATE SKIP LOCKED` row-lock clause AND a genuine second claim
-- UPDATE that really does write status = 'processing'. Must stay flagged.
WITH candidate AS (
  SELECT id FROM message_jobs
   WHERE status = 'queued'
   ORDER BY created_at
   FOR UPDATE SKIP LOCKED
)
UPDATE message_jobs
   SET status = 'processing'
 WHERE id IN (SELECT id FROM candidate);
