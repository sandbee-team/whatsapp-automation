-- lease-release.sql (P06 Unit U3) - clean, voluntary lease release (as
-- opposed to a stale-lease reclaim by the discovery sweep, P09). Tenant-
-- scoped (runs under TenantDb.withTenant, role wp_app) AND fence-guarded:
-- only the CURRENT owner, holding the CURRENT fence, can release. Stamps
-- released_at and clears owner_worker_id so the instance immediately
-- becomes eligible for wp_lease_scan_unowned's discovery sweep again.
--
-- Zero rows (stale fence, wrong worker, or wrong tenant) is a NORMAL,
-- reported-as-false outcome - this statement never throws for "nothing to
-- release" (core invariant 2: an unclear/superseded state is handled by the
-- caller, never assumed to be an error here).

-- name: lease-release
UPDATE instance_lease_state
   SET owner_worker_id = NULL,
       released_at = now()
 WHERE instance_id = $instance_id
   AND client_id = $client_id
   AND current_fence = $fence
   AND owner_worker_id = $worker
RETURNING instance_id;
