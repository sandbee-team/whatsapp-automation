-- Fixture (P12, 2026-09-01): reproduces the real false-positive shape from
-- db/migrations/0027_reaper_and_reconcile_definer_functions.sql - a
-- `FOR UPDATE OF j SKIP LOCKED` row-lock clause on a claim/sweep CTE,
-- followed by a real UPDATE whose SET clause never writes 'processing'
-- (only 'queued' / 'needs_reconcile' / 'sent'), with a `--` comment that
-- itself contains the text `j.status = 'processing'`. That comment is the
-- actual trigger for the bug: without it this fixture does not reproduce it.
WITH expired AS (
  SELECT j.id
    FROM message_jobs j
   WHERE j.status = 'processing'
   ORDER BY j.lease_expires_at
   FOR UPDATE OF j SKIP LOCKED
)
UPDATE message_jobs j
   SET status = (CASE
         WHEN e.attempt_state = 'acked' THEN 'sent'
         WHEN e.attempt_state = 'dispatched' THEN 'needs_reconcile'
         ELSE 'queued' END)::job_status,
       updated_at = now()
  FROM expired e
 -- deviation: `j.id = e.id` alone disambiguates; `j.status = 'processing'`
 -- is the safety predicate that keeps this conditional, not blind.
 WHERE j.id = e.id AND j.status = 'processing';
