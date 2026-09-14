-- snapshot-audience-count.sql (P23 Unit U4, step 4) - the ceiling check run
-- ONCE before the very first snapshot batch (`snapshot_cursor_contact_id IS
-- NULL`). Counts DISTINCT live contacts matched by the audience JSON - the
-- SAME match predicate `snapshot-audience-batch.sql` uses, so the count this
-- query returns is exactly the number of rows the batches below will ever
-- insert (never an over- or under-count relative to the real snapshot walk).
-- client_id = $client_id.

-- name: snapshot-audience-count
SELECT count(*)::text AS count
  FROM contacts c
 WHERE c.client_id = $client_id
   AND c.deleted_at IS NULL
   AND (
     c.id = ANY($contact_ids::uuid[])
     OR EXISTS (
       SELECT 1 FROM contact_tag_links ctl
        WHERE ctl.client_id = c.client_id
          AND ctl.contact_id = c.id
          AND ctl.tag_id = ANY($tag_ids::uuid[])
     )
   );
