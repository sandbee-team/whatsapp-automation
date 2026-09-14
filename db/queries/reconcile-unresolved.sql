-- reconcile-unresolved.sql (P12 Unit U3, step 6) - cross-tenant read of
-- `needs_reconcile` jobs and their in-flight `send_attempts` evidence
-- (including the sibling-in-flight-count aggregate the ambiguity rule
-- needs). Executes as wp_scheduler through the read-only SECURITY DEFINER
-- function `wp_reconcile_scan_unresolved` (migration 0027, C12 correction) -
-- `wp_scheduler` is NOT BYPASSRLS and would see zero rows on a bare
-- cross-tenant SELECT against `message_jobs`/`send_attempts` (both FORCE
-- RLS, one `tenant_isolation` policy keyed on `app.client_id`).
--
-- Every WRITE the reconciler makes stays on the normal per-tenant RLS path
-- (`tenantDb.withTenant`, `reconciler.ts`'s own module doc) - this statement
-- is READ-ONLY and cross-tenant by necessity, exactly the same shape as
-- `lease-scan-unowned.sql`/`discover-instances.sql`. Registered in
-- `scripts/registries/cross-tenant-queries.ts` under
-- "db/queries/reconcile-unresolved.sql:reconcile-unresolved".
--
-- Callers pass window_seconds = TIMING.reconcileWindowMs / 1000,
-- tolerance_seconds = TIMING.echoToleranceMs / 1000, and a bounded max_rows
-- (never unbounded - same discipline as reap-expired-leases.sql's p_limit).

-- name: reconcile-unresolved
SELECT client_id, instance_id, message_job_id, message_job_created_at, unresolved_at,
       send_attempt_id, send_attempt_no, content_hash, dispatched_at, sibling_inflight_count
  FROM wp_reconcile_scan_unresolved($window_seconds, $tolerance_seconds, $max_rows);
