-- Fixture: OFFSET pagination is banned - lists are keyset-paginated. This
-- file deliberately violates sql-lint's no-offset-pagination clause.
SELECT id FROM message_jobs ORDER BY id LIMIT 20 OFFSET 40;
