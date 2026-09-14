-- Fixture (P09 debugger fix): sneaky true-positive shapes that the
-- clause-bound fix (`(?:(?!\bWHERE\b)[^;])*?`) must NOT accidentally exempt
-- alongside the WHERE-predicate false positive it fixes - a real SET-clause
-- write of 'processing', with an extra assignment before it on its own
-- line, no space around "=", and mixed keyword case.
UPDATE message_jobs
   SET updated_at = now(),
       status='processing'
 WHERE id = $1;
