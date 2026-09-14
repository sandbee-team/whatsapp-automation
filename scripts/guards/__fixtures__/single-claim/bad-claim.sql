-- Fixture: a raw-SQL second claim statement (not the canonical one).
UPDATE message_jobs
   SET status = 'processing'
 WHERE id = $1;
