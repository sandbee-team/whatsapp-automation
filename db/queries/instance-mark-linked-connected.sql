-- instance-mark-linked-connected.sql (P08 Unit U4) - ENGINE write: pairing
-- succeeded, the instance is now linked and connected. Fence-guarded - EVERY
-- engine write in this unit carries the exact P07 lease predicate family
-- (tenant + fence + worker), so a superseded worker's write can never land
-- here either (core invariant 2/3). `phone_e164` uses COALESCE against the
-- existing value: Baileys does not always resurface the phone number on
-- every connection event, so a NULL argument here must never clobber an
-- already-known number.

-- name: instance-mark-linked-connected
UPDATE whatsapp_instances
   SET link_state = 'linked',
       health_state = 'connected',
       needs_user_action = false,
       user_action_reason = NULL,
       last_connected_at = now(),
       owner_jid = $owner_jid,
       phone_e164 = COALESCE($phone_e164, whatsapp_instances.phone_e164),
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
