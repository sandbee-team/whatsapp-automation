-- instance-count-online.sql (P08 Unit U6c) - counts this client's
-- non-deleted `whatsapp_instances` rows with `desired_state = 'online'`, for
-- the `POST /v1/instances/:id/online` connected-slot cap
-- (`plan_limits.max_connected_instances`). Client-scoped, read-only.

-- name: instance-count-online
SELECT count(*)::int AS count
  FROM whatsapp_instances
 WHERE client_id = $client_id
   AND desired_state = 'online'
   AND deleted_at IS NULL;
