-- session-purge-durable.sql (P07 Unit U4) - fence-predicated DELETE of BOTH
-- durable session tables for one instance, run as two statements inside a
-- caller-provided transaction (pg-repo.ts's `purgeDurable` exposes each
-- DELETE separately; the full one-transaction purge including the epoch
-- bump and audit row is U5's store, composed on top of these). Tenant +
-- fence + lease-fence EXISTS predicated identically to the other write
-- statements in this unit - a stale owner must not be able to purge a live
-- session's durable material either.

-- name: session-purge-durable-creds
DELETE FROM whatsapp_session_credentials
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
RETURNING instance_id;
