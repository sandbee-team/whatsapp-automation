-- Fixture: a comment mention of OFFSET (clean) followed by a real executable
-- OFFSET clause (violation). Exactly the executable one must be flagged.

-- keyset only, no OFFSET in real queries:
SELECT id
  FROM fixture_table
 WHERE client_id = $1
 ORDER BY id
 LIMIT 50 OFFSET 100;
