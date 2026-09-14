-- groups-list.sql (P24 Unit U3, step 4) - the tenant group list's keyset
-- page: `(id)` ascending, client_id + instance_id scoped, excludes a group
-- that has already left (`left_at IS NOT NULL`). `$after_id` is NULL for the
-- first page (the cursor codec's own decode, groups-cursor.ts, never binds
-- an empty string). LIMIT is mandatory (.claude/rules/database.md) - the
-- caller passes `$limit` already inclusive of the "peek one extra row to
-- decide nextCursor" convention (same idiom as contacts.repo.ts's own list).
SELECT id, instance_id, subject, participant_count, is_announce, our_role,
       send_enabled, send_enabled_at, disabled_reason, tracked_participant_devices,
       last_synced_at, last_message_at, leave_requested_at
  FROM wa_groups
 WHERE client_id = $client_id
   AND instance_id = $instance_id
   AND left_at IS NULL
   AND ($after_id::uuid IS NULL OR id > $after_id::uuid)
 ORDER BY id ASC
 LIMIT $limit;
