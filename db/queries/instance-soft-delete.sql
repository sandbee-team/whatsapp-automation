-- instance-soft-delete.sql (P08 Unit U4) - TENANT-ACTION write: soft-delete
-- only (`deleted_at = now()`), never a hard DELETE (wp_app has no DELETE
-- grant on this table at all - migration 0023 ITEM 4's deliberate omission).
-- Also parks the instance (`desired_state = 'offline'`) as part of the SAME
-- explicit human action - deleting an instance is itself the human decision
-- that authorises parking it, not a signal-driven side effect (core
-- invariant 6 is about signals, not this explicit call). `deleted_at IS
-- NULL` makes a repeat call a harmless no-op (zero rows), never a double
-- soft-delete.

-- name: instance-soft-delete
UPDATE whatsapp_instances
   SET deleted_at = now(),
       desired_state = 'offline',
       updated_at = now()
 WHERE id = $instance_id
   AND client_id = $client_id
   AND deleted_at IS NULL
RETURNING id;
