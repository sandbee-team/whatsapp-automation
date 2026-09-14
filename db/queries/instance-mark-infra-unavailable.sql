-- instance-mark-infra-unavailable.sql (P09 Unit U3) - discovery's 3-
-- consecutive-cycle escalation write (step 7): marks an instance that has
-- been unowned AND ungrabbed for 3 straight discovery cycles as
-- `health_state = 'degraded'`, `needs_user_action = true`,
-- `user_action_reason = 'INFRA_UNAVAILABLE'`. Client-scoped (TENANT-ACTION
-- shape, same family as instance-soft-delete.sql/instance-set-desired-
-- state.sql - no lease/fence predicate, since by definition NO worker holds
-- a lease on an instance discovery has been unable to place for 3 cycles).
--
-- IDEMPOTENT + CONDITIONAL (task requirement, core invariant 3): the WHERE
-- clause only matches a row that is not ALREADY exactly
-- (health_state='degraded', needs_user_action=true,
-- user_action_reason='INFRA_UNAVAILABLE') - a repeat call once the escalation
-- has already landed is a zero-row no-op (`RETURNING id` empty), never a
-- second write/second audit row. `deleted_at IS NULL` excludes a
-- meanwhile-deleted instance (zero effect, never resurrects a soft-deleted
-- row). No `desired_state`/lease predicate is needed beyond that: if the
-- instance was re-owned meanwhile (a worker won the lease between the last
-- scan and this write landing), health_state/user_action_reason may already
-- have moved on past 'degraded'/'INFRA_UNAVAILABLE' from the runner's own
-- engine writes - this statement's own idempotent guard only ever asserts
-- the ONE state it is responsible for, never overwrites an unrelated state a
-- legitimate owner has since written (the discovery worker calling this
-- never holds this instance's lease, so it cannot itself distinguish
-- "still genuinely unowned" from "just re-owned" any more precisely than
-- "does the row already show my target state" - a real race window is
-- accepted here and documented, not hidden: worst case this statement briefly
-- overwrites a state that changed a moment after the discovery worker's last
-- unowned sighting, which the FSM's own subsequent engine writes correct on
-- the very next real transition).
--
-- Touches ZERO `message_jobs` rows (core invariant 5) - this statement's
-- FROM/UPDATE target is `whatsapp_instances` only.

-- name: instance-mark-infra-unavailable
UPDATE whatsapp_instances
   SET health_state = 'degraded',
       needs_user_action = true,
       user_action_reason = 'INFRA_UNAVAILABLE',
       updated_at = now()
 WHERE id = $instance_id
   AND client_id = $client_id
   AND deleted_at IS NULL
   AND (health_state IS DISTINCT FROM 'degraded'
        OR needs_user_action IS DISTINCT FROM true
        OR user_action_reason IS DISTINCT FROM 'INFRA_UNAVAILABLE')
RETURNING id;
