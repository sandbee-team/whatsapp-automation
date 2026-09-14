-- Fixture: a conditional-transition UPDATE that reads consumed_count only
-- in a WHERE predicate and never writes any of the four tracked columns -
-- must stay clean (mirrors clean-where-predicate.sql in the single-claim
-- fixtures).
UPDATE pacing_ledger
   SET updated_at = now()
 WHERE instance_id = $1 AND ledger_date = $2 AND consumed_count < 10;
