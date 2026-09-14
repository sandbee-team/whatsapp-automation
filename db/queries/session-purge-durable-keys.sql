-- session-purge-durable-keys.sql (P07 Unit U4) - second half of the durable
-- purge pair (see session-purge-durable-creds.sql's header comment for the
-- full rationale) - the `whatsapp_session_keys` DELETE, same tenant + fence
-- + lease-fence EXISTS predicates. RETURNING key_id so the caller
-- (pg-repo.ts's `purgeDurable`) can report an accurate `keysDeleted` count.

-- name: session-purge-durable-keys
DELETE FROM whatsapp_session_keys
 WHERE instance_id = $instance_id
   AND client_id = $client_id
   AND owner_fence <= $fence
   AND EXISTS (
     SELECT 1 FROM instance_lease_state ls
      WHERE ls.instance_id = $instance_id
        AND ls.client_id = $client_id
        AND ls.current_fence = $fence
        AND ls.owner_worker_id = $worker_id
   )
RETURNING key_id;
