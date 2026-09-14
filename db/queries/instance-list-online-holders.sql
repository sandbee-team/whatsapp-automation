-- instance-list-online-holders.sql (P08 Unit U6c) - lists this client's
-- non-deleted, currently-online (`desired_state = 'online'`) instances, for
-- the `POST /v1/instances/:id/online` 409 NO_FREE_SLOT response body (which
-- names the holders currently occupying a connected slot). Client-scoped,
-- read-only; `phone_e164` is masked by the route/service layer before it
-- ever leaves the API (the full number never leaves the API, per canon) -
-- this statement returns the raw column only for that same-process masking
-- step, never as a response field itself.

-- name: instance-list-online-holders
SELECT id, label, phone_e164
  FROM whatsapp_instances
 WHERE client_id = $client_id
   AND desired_state = 'online'
   AND deleted_at IS NULL
 ORDER BY created_at ASC;
