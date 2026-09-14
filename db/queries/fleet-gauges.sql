-- fleet-gauges.sql (P09 Unit U3) - the two fleet-capacity gauge counts:
-- `unowned_count` (wp_instances_unowned) and `desired_online_count` (feeds
-- wp_fleet_capacity_headroom = Sigma(published worker caps) -
-- desired_online_count, computed in discovery.ts once the Redis-side worker
-- caps are summed - this statement supplies only the Postgres half).
--
-- unowned_count predicate (blueprint [R-37], same liveness window as
-- discover-instances.sql/wp_lease_scan_unowned's 45s stale threshold, kept
-- literal here rather than parameterized since this is a plain aggregate
-- query, not a SECURITY DEFINER function): desired_state = 'online' AND
-- deleted_at IS NULL, joined to instance_lease_state exactly the same
-- LEFT JOIN shape wp_lease_scan_unowned uses (no lease row at all, OR a
-- stale one, both count as unowned) - link_state/health_state are NOT part
-- of this predicate (the gauge counts capacity-relevant unowned instances,
-- not scan-eligible ones; a logged_out or unlinked-but-desired-online
-- instance still counts against fleet capacity headroom even though the
-- discovery scan itself would skip it).
--
-- desired_online_count: every non-deleted whatsapp_instances row with
-- desired_state = 'online', regardless of lease/link/health state - the
-- denominator side of headroom (every session the fleet is supposed to be
-- carrying right now).
--
-- Cross-tenant (both halves), no client_id predicate - registered in
-- scripts/registries/cross-tenant-queries.ts under this file's own key.
-- Counts only, no per-row projection - safe against the tenant-isolation
-- guard's column-exposure concern by construction.

-- name: fleet-gauges
SELECT
  (
    SELECT count(*)::int
      FROM whatsapp_instances i
      LEFT JOIN instance_lease_state ls
        ON ls.instance_id = i.id AND ls.client_id = i.client_id
     WHERE i.desired_state = 'online'
       AND i.deleted_at IS NULL
       AND (ls.instance_id IS NULL
            OR ls.lease_seen_at IS NULL
            OR ls.lease_seen_at < now() - interval '45 seconds')
  ) AS unowned_count,
  (
    SELECT count(*)::int
      FROM whatsapp_instances i
     WHERE i.desired_state = 'online'
       AND i.deleted_at IS NULL
  ) AS desired_online_count;
