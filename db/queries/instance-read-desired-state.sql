-- instance-read-desired-state.sql (P08 FIX BATCH B / B1) - small, client-
-- scoped read of the target instance's own current `desired_state`, used by
-- `setOnlineWithSlotCheck`'s short-circuit: re-onlining an ALREADY-online
-- instance must be a no-op success, never counted against its own slot (see
-- instance-online-slot.repo.ts's own header comment for the full race
-- history). `deleted_at IS NULL` excludes a soft-deleted instance the same
-- way every other tenant-action statement in this module does; a caller
-- that gets no row back treats it as "not found" (same as
-- instance-set-desired-state.sql's own RETURNING-based convention).

-- name: instance-read-desired-state
SELECT id, desired_state
  FROM whatsapp_instances
 WHERE id = $instance_id
   AND client_id = $client_id
   AND deleted_at IS NULL;
