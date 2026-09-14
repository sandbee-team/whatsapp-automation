-- lease-mint-fence.sql (P06 Unit U3) - second half of the fence-mint pair;
-- always run in the SAME transaction as lease-mint-read-released.sql,
-- immediately after it (see lease-state-repo.ts's mintFence). Tenant-scoped
-- (runs under TenantDb.withTenant, role wp_app).
--
-- Monotonic by construction: current_fence starts at 1 for a never-leased
-- instance (the INSERT branch) and is unconditionally incremented by
-- exactly 1 on every subsequent mint (the ON CONFLICT DO UPDATE branch,
-- current_fence = current_fence + 1) - a fresh worker minting a NEW fence
-- for an instance always strictly outranks every fence minted before it,
-- which is what lets claim-jobs.sql's ls.current_fence-equals-caller-fence
-- predicate reject a superseded worker outright (ADR 0029, core invariant
-- 2). Clears
-- released_at back to NULL (the instance is owned again) and stamps
-- lease_seen_at = now() (this mint also counts as the first liveness
-- signal - no separate renew call is required immediately after a mint).

-- name: lease-mint-fence
INSERT INTO instance_lease_state
  (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at, released_at)
VALUES
  ($instance_id, $client_id, 1, $worker, now(), NULL)
ON CONFLICT (instance_id) DO UPDATE
   SET current_fence = instance_lease_state.current_fence + 1,
       owner_worker_id = $worker,
       lease_seen_at = now(),
       released_at = NULL
 WHERE instance_lease_state.client_id = $client_id
RETURNING current_fence;
