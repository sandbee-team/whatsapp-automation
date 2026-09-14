-- instance-link-status.sql (P08 Unit U6c) - small, client-scoped read for
-- `GET /v1/instances/:id/link-status`. SELECT-only, no fence predicate (same
-- reasoning as instance-read-session-epoch.sql: this is a tenant-facing read,
-- not an engine write, so there is no lease to guard against). `deleted_at IS
-- NULL` excludes a soft-deleted instance the same way every other
-- tenant-action statement in this module does.

-- name: instance-link-status
SELECT link_state,
       health_state,
       desired_state,
       needs_user_action,
       user_action_reason,
       qr_attempts,
       phone_e164
  FROM whatsapp_instances
 WHERE id = $instance_id
   AND client_id = $client_id
   AND deleted_at IS NULL;
