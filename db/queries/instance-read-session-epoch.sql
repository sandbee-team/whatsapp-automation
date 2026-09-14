-- instance-read-session-epoch.sql (P08 Unit U5a) - small, client-scoped
-- read of the current `session_epoch`, `health_state`, and `link_state` for
-- one instance. No fence predicate: this runs BEFORE the runner builds its
-- `AuthStoreIdentity` (which itself carries the epoch the auth store
-- enforces on writes), so the runner must already know the epoch before any
-- lease/fence write exists for this call to guard against - a plain
-- client-scoped SELECT is correct here, not a gap in the fence discipline.
-- `health_state`/`link_state` seed the runner's OWN in-memory FSM tracking
-- (the U4 seam: `applyEngineTransition` takes `fromHealth` as a parameter,
-- the runner tracks it in memory from its own transitions, initialised from
-- this one read at start).

-- name: instance-read-session-epoch
SELECT session_epoch, health_state, link_state
  FROM whatsapp_instances
 WHERE id = $instance_id
   AND client_id = $client_id;
