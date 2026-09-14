-- Fixture: the word OFFSET appearing only inside opaque spans (a line
-- comment and a string literal) must not trip sql-lint/no-offset-pagination.
-- This mirrors db/migrations/0048's real index comment ("keyset list, no
-- OFFSET - phase step 6") that documented compliance and got flagged.

-- Full per-client timeline (keyset list endpoint, no OFFSET - keyset only):
CREATE INDEX fixture_list_idx
  ON fixture_table (client_id, created_at DESC, id DESC);

INSERT INTO fixture_copy (key, value)
VALUES ('pagination-note', 'lists are keyset-paginated, never OFFSET counted');

SELECT id
  FROM fixture_table
 WHERE client_id = $1
   AND (created_at, id) < ($2, $3)
 ORDER BY created_at DESC, id DESC
 LIMIT $4;
