-- Fixture (P12 Unit U5) - a real transition out of blocked_needs_review,
-- surrounded by -- comments (some of which themselves mention
-- 'blocked_needs_review' in prose) that must not hide the real statement
-- below from detection.
-- note: this comment also says status = 'blocked_needs_review' as prose,
-- not as code - it must not by itself trigger a false negative OR a false
-- positive on its own.
UPDATE message_jobs
   -- SET status = 'queued', a real transition, commented here again
   SET status = 'queued', next_attempt_at = now()
 -- WHERE clause below is the real guard predicate
 WHERE id = 1 AND status = 'blocked_needs_review';
-- end of fixture
