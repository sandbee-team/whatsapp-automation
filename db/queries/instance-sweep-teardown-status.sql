-- instance-sweep-teardown-status.sql (P08 FIX BATCH A, A9; FIX ROUND 2 FIX 1)
-- - ONE batched, CLIENT-scoped read a session worker runs per bootstrap-scan
-- tick, per client, across every instance it currently holds a registry
-- handle for THAT client. Replaced the earlier cross-tenant (no client_id
-- predicate) version: `whatsapp_instances` has FORCE ROW LEVEL SECURITY
-- keyed on `app.client_id`, and the worker role `wp_app` does NOT bypass
-- RLS - a bare, unscoped read under that role silently returned ZERO rows in
-- production (proven under `SET LOCAL ROLE wp_app`), which the caller's
-- fail-safe-shaped "absent id = ineligible" logic then misread as "every
-- held session is ineligible", mass-tearing-down every healthy session each
-- tick. The client_id predicate below is both the RLS-satisfying scope AND
-- the honest `check-tenant-scope` predicate - this statement is no longer
-- registered in `scripts/registries/cross-tenant-queries.ts`.
--
-- The caller (`session-worker-composition.ts#sweepTeardowns`) groups its
-- held handles by `clientId` and runs this once per client-with-held-
-- sessions per tick (O(clients), not O(sessions)) - never once globally.
--
-- A row simply absent from the result set (already hard-deleted, or an id
-- the caller passed that never existed for THIS client) is still possible
-- and is still treated the same fail-safe way by the caller - but the
-- caller now fails CLOSED on any short read: a missing id is skipped
-- (session kept) unless some OTHER row in the same batch positively proves
-- ineligibility for that same id (never true, ids are unique) - see the
-- caller's own header comment for the full fail-closed contract.

-- name: instance-sweep-teardown-status
SELECT id,
       desired_state,
       deleted_at
  FROM whatsapp_instances
 WHERE id = ANY($instance_ids::uuid[])
   AND client_id = $client_id;
