-- erase-contact.sql (P20 Unit U6, step 7) - the per-contact erasure query.
-- SOFT delete + PII scrub, per the phase: `deleted_at` is set and
-- `display_name`/`first_name`/`last_name`/`attrs`/`lid_jid` are scrubbed;
-- the tag links are deleted and each affected tag's `contact_count` is
-- decremented in the SAME statement (no separate round-trip). NEVER a real
-- DELETE - `phone_e164`/`phone_hash`/`wa_jid` stay on the tombstoned row
-- (NOT NULL columns, and `phone_hash` is the join key to `opt_outs`); the
-- `opt_outs` row for this recipient is NEVER touched here - deleting an
-- opt-out is how you would re-message someone who said stop, and this
-- query has no business doing that. The full DSAR (data-subject-access-
-- request) pipeline is a later phase (P28); this is the tenant-triggered
-- per-contact erasure only.

-- name: erase-contact
WITH unlinked AS (
  DELETE FROM contact_tag_links WHERE client_id = $client_id AND contact_id = $contact_id RETURNING tag_id
), recount AS (
  UPDATE contact_tags t SET contact_count = GREATEST(t.contact_count - u.n, 0)
    FROM (SELECT tag_id, count(*)::int AS n FROM unlinked GROUP BY tag_id) u
   WHERE t.client_id = $client_id AND t.id = u.tag_id
)
UPDATE contacts SET deleted_at = now(), display_name = NULL, first_name = NULL, last_name = NULL,
                    attrs = '{}'::jsonb, lid_jid = NULL, updated_at = now()
 WHERE client_id = $client_id AND id = $contact_id AND deleted_at IS NULL
RETURNING id, deleted_at;
