-- session-purge-epoch-bump.sql (P07 Unit U5) - the third statement of
-- `store.ts`'s one-transaction `purge`: bumps `whatsapp_instances.
-- session_epoch` by exactly 1, gated on the SAME lease-fence EXISTS
-- predicate as the two durable-table deletes it runs alongside
-- (session-purge-durable-creds.sql / session-purge-durable-keys.sql) - a
-- stale caller's purge must not bump the epoch either. Zero rows here is
-- the transaction's fence-conflict signal: the caller rolls back the WHOLE
-- transaction (including whatever the two deletes above may have removed)
-- rather than committing a partial purge - see store.ts's `purge`.

-- name: session-purge-epoch-bump
UPDATE whatsapp_instances
   SET session_epoch = session_epoch + 1, updated_at = now()
 WHERE id = $instance_id
   AND client_id = $client_id
   AND EXISTS (
     SELECT 1 FROM instance_lease_state ls
      WHERE ls.instance_id = $instance_id
        AND ls.client_id = $client_id
        AND ls.current_fence = $fence
        AND ls.owner_worker_id = $worker_id
   )
RETURNING session_epoch;
