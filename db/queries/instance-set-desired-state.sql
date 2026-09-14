-- instance-set-desired-state.sql (P08 Unit U4) - TENANT-ACTION write: the
-- ONLY statement in this schema allowed to change `desired_state`
-- ('online'|'offline') - explicit human action only (core invariant 6 / the
-- "no code path may set desired_state from a signal" rule). Callers audit
-- this call themselves (repo.ts exposes it as a thin wrapper with no
-- signal-driven caller anywhere in this module). Client-scoped, no lease/
-- fence predicate - desired_state is the tenant's OWN intent, set
-- independently of whichever worker (if any) currently holds the lease.

-- name: instance-set-desired-state
UPDATE whatsapp_instances
   SET desired_state = $desired_state,
       updated_at = now()
 WHERE id = $instance_id
   AND client_id = $client_id
   AND deleted_at IS NULL
RETURNING id;
