-- purge-import-errors.sql (P20 Unit U7, step 8) - the 30-day import
-- retention purge's error-row half (`retention-purge.ts`'s companion
-- object-store sweep handles the CSV upload objects). Deletes error rows for
-- imports older than $cutoff, BOUNDED by $limit (ADR 0018 S4 - never an
-- unbounded per-sweep scan; several sweeps converge on a large backlog).
-- NEVER deletes `contact_imports` rows or `contacts` - only
-- `contact_import_errors`, and only for the calling tenant (`$client_id` on
-- both sides of the join).

-- name: purge-import-errors
DELETE FROM contact_import_errors e
 USING contact_imports i
 WHERE e.client_id = $client_id AND i.client_id = $client_id AND i.id = e.import_id
   AND i.created_at < $cutoff
   AND (e.import_id, e.row_no) IN (
     SELECT e2.import_id, e2.row_no
       FROM contact_import_errors e2
       JOIN contact_imports i2 ON i2.id = e2.import_id AND i2.client_id = $client_id
      WHERE e2.client_id = $client_id AND i2.created_at < $cutoff
      LIMIT $limit
   )
RETURNING e.import_id;
