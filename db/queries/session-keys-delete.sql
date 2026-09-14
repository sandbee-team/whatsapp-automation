-- session-keys-delete.sql (P07 Unit U4) - batched fence-predicated DELETE of
-- `whatsapp_session_keys` rows (the null-blob branch of `setKeys` - a caller
-- asking to forget specific key ids, e.g. a consumed pre-key). Tenant +
-- fence + lease-fence EXISTS predicated, same as session-keys-upsert.sql.
--
-- FIX-B SUGGESTION-7 (symmetry with session-keys-upsert.sql/
-- session-creds-upsert.sql): also requires the same
-- `EXISTS (SELECT 1 FROM whatsapp_instances wi WHERE wi.id = $instance_id
-- AND wi.client_id = $client_id AND wi.session_epoch = $session_epoch)`
-- epoch-blind-write guard - a delete built at a pre-purge epoch must not
-- land either.
--
-- RETURNING key_id so the caller can detect a partial/zero-row miss exactly
-- like the upsert path.

-- name: session-keys-delete
DELETE FROM whatsapp_session_keys
 WHERE instance_id = $instance_id
   AND client_id = $client_id
   AND key_type = $key_type
   AND key_id = ANY($key_ids::text[])
   AND owner_fence <= $fence
   AND EXISTS (
     SELECT 1 FROM instance_lease_state ls
      WHERE ls.instance_id = $instance_id
        AND ls.client_id = $client_id
        AND ls.current_fence = $fence
        AND ls.owner_worker_id = $worker_id
   )
   AND EXISTS (
     SELECT 1 FROM whatsapp_instances wi
      WHERE wi.id = $instance_id
        AND wi.client_id = $client_id
        AND wi.session_epoch = $session_epoch
   )
RETURNING key_id;
