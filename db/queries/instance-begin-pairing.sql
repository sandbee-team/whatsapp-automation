-- instance-begin-pairing.sql (P08 Unit U4) - TENANT-ACTION write: starts a
-- fresh pairing intent. Client-scoped only, no lease/fence predicate (the
-- engine has not claimed this instance yet at this point - pairing intent is
-- what MAKES it eligible for the bootstrap scan, migration 0022's
-- wp_session_bootstrap_scan). `deleted_at IS NULL` keeps a soft-deleted
-- instance from ever being resurrected into a pairing intent by this path.
-- Resets `qr_attempts` to 0 and clears any prior "needs user action" state -
-- a fresh pairing attempt starts with a clean slate.

-- name: instance-begin-pairing
UPDATE whatsapp_instances
   SET desired_state = 'online',
       link_state = 'pairing',
       pairing_started_at = now(),
       qr_attempts = 0,
       needs_user_action = false,
       user_action_reason = NULL,
       updated_at = now()
 WHERE id = $instance_id
   AND client_id = $client_id
   AND deleted_at IS NULL
RETURNING id;
