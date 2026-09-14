-- Fixture (scripts/guards/__fixtures__ - excluded from the real repo scan
-- by CONTENT_EXCLUSIONS): a second, forbidden statement consuming a pacing
-- unit outside db/queries/reserve-pacing.sql. Proves scanSingleReserve()
-- flags any consumed_count write against pacing_ledger from any other
-- file.
UPDATE pacing_ledger
   SET consumed_count = consumed_count + 1
 WHERE instance_id = $1 AND ledger_date = $2;
