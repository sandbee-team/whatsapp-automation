-- instance-reset-pairing-window.sql (P08 Unit U4) - TENANT-ACTION write: lets
-- a caller retry a pairing window that is either still mid-pairing or that
-- expired (`user_action_reason = 'PAIRING_EXPIRED'`) - the ONLY two states
-- this reset is allowed to fire from (the WHERE clause's own OR), so it can
-- never resurrect a completely different "needs user action" reason (e.g.
-- RESTRICTION_SIGNAL/RELINK_REQUIRED) into a silent retry. Client-scoped, no
-- lease/fence predicate (same reasoning as instance-begin-pairing.sql - the
-- engine has not necessarily claimed this instance at reset time either).

-- name: instance-reset-pairing-window
UPDATE whatsapp_instances
   SET pairing_started_at = now(),
       qr_attempts = 0,
       needs_user_action = false,
       user_action_reason = NULL,
       updated_at = now()
 WHERE id = $instance_id
   AND client_id = $client_id
   AND deleted_at IS NULL
   AND (link_state = 'pairing' OR user_action_reason = 'PAIRING_EXPIRED')
RETURNING id;
