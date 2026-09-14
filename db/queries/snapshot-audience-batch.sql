-- snapshot-audience-batch.sql (P23 Unit U4, step 4) - Phase A's one-batch
-- keyset read over `contacts`, LEFT JOINed to the ACTIVE opt-out registry
-- (client-scope only: a broadcast is not addressed through one instance's
-- opt-out scope at snapshot time - `opt_outs_lookup`'s partial unique index
-- is `WHERE restored_at IS NULL`, so this join naturally only matches a
-- currently-active opt-out row). Reads the next 1,000 contacts strictly
-- after `$cursor_contact_id` (keyset over `contacts.id`), `deleted_at IS
-- NULL` only - a deleted contact is never snapshotted.
--
-- `$contact_ids`/`$tag_ids` are the audience JSON's own `contactIds`/`tagIds`
-- arrays (each may be empty - `= ANY('{}'::uuid[])` correctly matches
-- nothing, never everything). A contact matches when EITHER its id is in
-- the explicit list OR it carries at least one of the given tags via
-- `contact_tag_links`.
--
-- client_id = $client_id (contacts, contact_tag_links, opt_outs all scoped).

-- name: snapshot-audience-batch
SELECT
  c.id AS contact_id,
  c.wa_jid,
  c.phone_e164,
  c.phone_hash,
  c.first_name,
  c.last_name,
  c.display_name,
  c.attrs,
  (o.id IS NOT NULL) AS is_opted_out
FROM contacts c
LEFT JOIN opt_outs o
  ON o.client_id = c.client_id
 AND o.phone_hash = c.phone_hash
 AND o.restored_at IS NULL
 AND ((o.scope = 'client' AND o.scope_key = $client_id))
WHERE c.client_id = $client_id
  AND c.deleted_at IS NULL
  AND c.id > $cursor_contact_id
  AND (
    c.id = ANY($contact_ids::uuid[])
    OR EXISTS (
      SELECT 1 FROM contact_tag_links ctl
       WHERE ctl.client_id = c.client_id
         AND ctl.contact_id = c.id
         AND ctl.tag_id = ANY($tag_ids::uuid[])
    )
  )
ORDER BY c.id
LIMIT $batch_size;
