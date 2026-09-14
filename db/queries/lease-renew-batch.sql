-- lease-renew-batch.sql (P06 Unit U3) - the ONE batched lease-liveness renew
-- a worker runs per tick, across EVERY instance it currently holds a lease
-- for (ADR 0018 SS4 / scope-delta row 2: at 1,000+ concurrent sessions a
-- per-lease renew loop degenerates into per-session row updates and must
-- never be added - see lease-state-repo.ts's SAFETY BOUNDARY comment).
--
-- Deliberately carries NO client_id predicate: this statement crosses
-- tenants by design (one worker's held leases span many clients) and is
-- authorized instead by the lease_owner_renew RLS policy (migration 0018,
-- ADR 0029 SS3), which the caller keys by setting the `app.worker_id` GUC
-- transaction-locally before running this statement (see
-- lease-state-repo.ts's renewBatch). Registered in
-- scripts/registries/cross-tenant-queries.ts under
-- "db/queries/lease-renew-batch.sql:lease-renew-batch".
--
-- Every row this UPDATE can even see is already filtered to
-- owner_worker_id = current caller by the policy; the statement ALSO keeps
-- its own fence + owner_worker_id predicates so a stale-fence row and an
-- RLS-filtered (not-my-lease) row are indistinguishable outcomes at the
-- caller - both simply do not appear in RETURNING (fail-safe: core
-- invariant 2, never distinguish "someone else's lease" from "my fence went
-- stale").
--
-- Zero rows returned for a given (instance_id, fence) pair is a NORMAL,
-- reported-as-a-conflict outcome, never a throw.

-- name: lease-renew-batch
UPDATE instance_lease_state ls
   SET lease_seen_at = now()
  FROM unnest($ids::uuid[], $fences::bigint[]) AS t(instance_id, fence)
 WHERE ls.instance_id = t.instance_id
   AND ls.current_fence = t.fence
   AND ls.owner_worker_id = $worker
RETURNING ls.instance_id;
