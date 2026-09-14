-- Fixture (P12, 2026-09-01): proves the comment-blanking fix did not open a
-- hole - a real SET status = 'processing' surrounded by / interleaved with
-- `--` comments on every side. Must stay flagged.
-- a comment mentioning message_jobs before the statement
UPDATE message_jobs j
   -- comment before SET
   SET
   -- comment inside the assignment list
   status = 'processing' -- trailing comment on the same line
 WHERE j.id = 1;
