-- instance-count-online-others.sql (P08 FIX BATCH B / B1) - counts this
-- client's non-deleted, currently-online `whatsapp_instances` rows EXCLUDING
-- the target instance itself (`id <> $instance_id`). Used ONLY by the
-- connected-slot cap check in `setOnlineWithSlotCheck`
-- (instance-online-slot.repo.ts) - the plain `instance-count-online.sql`
-- (no exclusion) stays as-is for its own read paths (link-status counters,
-- etc.) where the target is not itself a candidate for the slot being
-- checked. Excluding the target here fixes the off-by-one where
-- re-onlining an already-online instance counted itself as an occupant of
-- the very slot it is asking for. Client-scoped, read-only.

-- name: instance-count-online-others
SELECT count(*)::int AS count
  FROM whatsapp_instances
 WHERE client_id = $client_id
   AND desired_state = 'online'
   AND deleted_at IS NULL
   AND id <> $instance_id;
