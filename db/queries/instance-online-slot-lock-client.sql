-- instance-online-slot-lock-client.sql (P08 E3 FIX 3) - the per-tenant slot
-- mutex for `POST /v1/instances/:id/online`'s check-and-set race (two
-- concurrent online requests could both observe onlineCount < maxConnected
-- and both pass). Locks the CALLING CLIENT's own `clients` row
-- (`FOR UPDATE`, client_id-scoped) inside the same transaction that then
-- counts online instances and conditionally writes `desired_state` - this
-- serialises racing online calls for the SAME client without a new lock
-- table. `wp_app` holds SELECT+UPDATE on `public.clients` (migration 0005),
-- so `FOR UPDATE` is a privilege-legal lock for this role (verified live
-- 2026-08-31 via has_table_privilege('wp_app','public.clients','UPDATE')).
-- Cheap and uncontended except during genuinely racing online calls for one
-- client - every other client's row is untouched.

-- name: instance-online-slot-lock-client
SELECT id
  FROM clients
 WHERE id = $client_id
 -- client_id = id = $client_id (clients' own PK IS the tenant id - same
 -- scanner precedent as instance-plan-limits.sql/provisioning.repo.ts's
 -- insertClient)
   FOR UPDATE;
