-- instance-apply-transition.sql (P08 Unit U4) - ENGINE write: the general-
-- purpose transition statement backing `applyDisconnect`'s outcomes
-- (degraded/paused/reconnect-failed/session-replaced/restriction) - anything
-- that is NOT one of this unit's other, more specific engine writes
-- (markLinkedConnected/markPairingExpired/markLoggedOut). Fence-guarded (same
-- lease predicate family as every other engine write here).
--
-- `link_state = COALESCE($link_state, whatsapp_instances.link_state)`: most
-- disconnect outcomes only ever move health_state (session-fsm.ts's
-- `Transition.linkState` is optional and omitted for e.g. a plain
-- degrade/pause) - a NULL argument here must leave link_state untouched,
-- never null it out.
--
-- `paused_at = CASE WHEN $health_state = 'paused' THEN now() ELSE
-- whatsapp_instances.paused_at END`: only stamps a FRESH pause moment when
-- this transition is itself the one entering 'paused' - a degrade/reconnect
-- transition that leaves health_state at some other value must never
-- overwrite an existing paused_at from a PRIOR pause.
--
-- `disconnection_reason_at = now()` unconditionally: every call to this
-- statement represents a real disconnect-policy outcome, so the "as of"
-- timestamp for whatever code/label it carries always advances.

-- name: instance-apply-transition
UPDATE whatsapp_instances
   SET health_state = $health_state,
       link_state = COALESCE($link_state, whatsapp_instances.link_state),
       needs_user_action = $needs_user_action,
       user_action_reason = $user_action_reason,
       pause_reason = $pause_reason,
       paused_at = CASE WHEN $health_state::wa_health = 'paused' THEN now() ELSE whatsapp_instances.paused_at END,
       disconnection_reason_code = $disconnection_reason_code,
       disconnection_reason_label = $disconnection_reason_label,
       disconnection_reason_at = now(),
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
