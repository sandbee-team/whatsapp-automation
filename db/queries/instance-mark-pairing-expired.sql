-- instance-mark-pairing-expired.sql (P08 Unit U4) - ENGINE write: the
-- pairing window ran out before a phone ever completed linking. Fence-
-- guarded (same lease predicate family as every other engine write here).
-- Health state is deliberately left untouched (an expired pairing attempt on
-- an instance that was never linked yet stays at whatever health_state it
-- already carried, typically 'never_linked' - this statement only ever
-- touches link_state/needs_user_action/user_action_reason).

-- name: instance-mark-pairing-expired
UPDATE whatsapp_instances
   SET link_state = 'unlinked',
       needs_user_action = true,
       user_action_reason = 'PAIRING_EXPIRED',
       updated_at = now()
 WHERE id = $instance_id
   AND client_id = $client_id
   AND EXISTS (
     SELECT 1 FROM instance_lease_state ls
      WHERE ls.instance_id = $instance_id
        AND ls.client_id = $client_id
        AND ls.current_fence = $fence
        AND ls.owner_worker_id = $worker_id
   )
RETURNING id;
