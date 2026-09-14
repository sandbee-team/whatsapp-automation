-- Fixture: a standalone session-scoped SET statement is still banned even
-- when it follows an unrelated UPDATE ... SET statement earlier in the same
-- file - proves the guard's per-statement "kind" tracking resets at every
-- top-level `;` instead of exempting every SET for the rest of the file
-- once one legitimate UPDATE ... SET has been seen.
UPDATE message_jobs SET status = 'queued' WHERE id = 1;

SET search_path = public;
