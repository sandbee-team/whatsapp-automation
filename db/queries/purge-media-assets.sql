-- purge-media-assets.sql (P34 U-upload, ADR 0052 accepted item 7) - the
-- ROW-DRIVEN candidate set for the media retention purge: selects
-- `media_assets` rows whose COALESCE(last_used_at, created_at) is older
-- than $cutoff. This is the ONLY selection predicate - there is no status
-- gate the way `purge-terminal-import-objects.sql` has, because an asset has
-- no lifecycle states (it exists from upload until either a send references
-- it, which stamps last_used_at and pushes its own cutoff forward, or it
-- ages out). Bounded by $limit (ADR 0018 S4). `retention-purge.ts` deletes
-- the object THEN the row per candidate - an already-gone object is the
-- idempotency marker (no column needed), same convention as the contacts
-- purge.

-- name: purge-media-assets
SELECT id, storage_key
  FROM media_assets
 WHERE client_id = $client_id
   AND COALESCE(last_used_at, created_at) < $cutoff
 ORDER BY COALESCE(last_used_at, created_at) ASC
 LIMIT $limit;
