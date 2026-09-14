-- lease-scan-unowned.sql (P06 Unit U3) - cross-tenant discovery scan of
-- unowned, online instances (worker-fleet lease-grab source; the discovery
-- LOOP that calls this on a tick is P09's, out of scope here - this file is
-- query-only). Executes as wp_scheduler.
--
-- The eligibility predicate itself lives ENTIRELY inside the read-only
-- SECURITY DEFINER function `wp_lease_scan_unowned` (migration 0018, ADR
-- 0029 SS2) - this statement adds no additional filtering/ordering of its
-- own, on purpose (any predicate added here instead of in the definer
-- function would not get the function's fixed (instance_id, client_id)
-- projection guarantee). Registered in
-- scripts/registries/cross-tenant-queries.ts under
-- "db/queries/lease-scan-unowned.sql:lease-scan-unowned".
--
-- Callers pass stale_ms = TIMING.leaseTtlMs + TIMING.takeoverGraceMs
-- (packages/domain/src/timing.ts) and max_rows = 50.

-- name: lease-scan-unowned
SELECT instance_id, client_id FROM wp_lease_scan_unowned($stale_ms, $max_rows);
