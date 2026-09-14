-- ensure-partitions.sql - P03 step 1/3. Read directly by
-- db/src/partitions.ts (no shared query-loader exists yet - that lands with
-- P03 Unit B's claim-jobs.sql loader, a parallel unit's file).
--
-- Two named statements, split on the `-- name: <label>` markers below. Each
-- calls the owner-only partition-maintenance function created by its
-- matching migration (wp_ensure_month_partition - migration 0003;
-- wp_ensure_week_partition - migration 0009). Both functions have EXECUTE
-- revoked from PUBLIC (owner wp_migrator only, by design) - callers of
-- ensureAllPartitions() MUST supply a wp_migrator-privileged connection, not
-- the wp_app/wp_scheduler request-time pool.

-- name: ensureMonthlyPartition
SELECT public.wp_ensure_month_partition($1::regclass, $2::date);

-- name: ensureWeeklyPartition
SELECT public.wp_ensure_week_partition($1::regclass, $2::date);
