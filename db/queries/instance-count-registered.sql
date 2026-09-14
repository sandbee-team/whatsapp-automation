-- instance-count-registered.sql (P08 Unit U6c) - counts this client's
-- non-deleted `whatsapp_instances` rows, for the `POST /v1/instances`
-- registered-instance cap (`plan_limits.max_registered_instances`).
-- Client-scoped, read-only.

-- name: instance-count-registered
SELECT count(*)::int AS count
  FROM whatsapp_instances
 WHERE client_id = $client_id
   AND deleted_at IS NULL;
