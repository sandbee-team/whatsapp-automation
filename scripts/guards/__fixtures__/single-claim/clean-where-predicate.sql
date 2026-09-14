-- Fixture (P09 debugger fix): a conditional-transition UPDATE that sets a
-- DIFFERENT status and merely uses `status = 'processing'` as a WHERE
-- predicate (the standard "only transition a row still in the expected
-- state" shape this repo's queue rules require - see
-- app/backend/src/engine/fleet/drain.ts's markNeedsReconcile). The SET
-- clause never writes 'processing' - must stay clean.
UPDATE message_jobs
    SET status = 'needs_reconcile', updated_at = now()
  WHERE id = $1 AND client_id = $2 AND status = 'processing';
