-- Fixture (P03 close, re-review round item 4): a raw-SQL second claim
-- statement whose parameter bind uses a NAMED placeholder ($status) rather
-- than a positional one ($1) or an embedded literal - proves
-- PARAMETERIZED_STATUS_PATTERN's named-param alternation catches this shape
-- too, not just `$1`/`$2`-style positional binds.
UPDATE message_jobs
   SET status = $status
 WHERE id = $id;
