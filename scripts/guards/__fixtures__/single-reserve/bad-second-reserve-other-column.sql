-- Fixture: same shape, but hits a different one of the four tracked
-- columns (group_sent_count) - proves the guard is not narrowly matching
-- only consumed_count.
UPDATE pacing_ledger
   SET group_sent_count = group_sent_count + 1, updated_at = now()
 WHERE instance_id = $1 AND ledger_date = $2;
