-- Fixture (P03 close, guard hardening): a raw-SQL parameterized second claim
-- statement (not the canonical one) - the literal 'processing' value is
-- bound as a query parameter ($1) rather than embedded in the SQL text
-- itself, proving PARAMETERIZED_STATUS_PATTERN catches this shape in a raw
-- .sql file too, not just a TS/TSX string/template literal.
UPDATE message_jobs
   SET status = $1
 WHERE id = $2;
