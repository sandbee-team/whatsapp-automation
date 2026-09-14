-- instance-mark-logged-out.sql (P08 Unit U4) - ENGINE write: the provider
-- reported a real logout (not a mere disconnect) - the ONLY recovery path
-- from here is an explicit user re-pair (`RELINK_REQUIRED`), never an
-- automatic reconnect. Fence-guarded (same lease predicate family as every
-- other engine write here). This statement runs FIRST in service.ts's
-- logged-out flow, BEFORE the auth-store purge - see service.ts's own doc
-- comment for the crash-window ordering rationale (state-first; purge is
-- idempotent since P07).

-- name: instance-mark-logged-out
UPDATE whatsapp_instances
   SET health_state = 'logged_out',
       link_state = 'unlinked',
       needs_user_action = true,
       user_action_reason = 'RELINK_REQUIRED',
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
