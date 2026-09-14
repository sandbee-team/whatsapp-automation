-- groups-request-sync.sql (P24 Unit U3c) - the ONE conditional UPDATE that
-- records a tenant's group-sync request: allowed only when the instance's
-- worker-owned rate-limit clock (`groups_next_sync_after`) is unset or has
-- already elapsed. Migration 0068 grants `wp_app` a column-scoped UPDATE on
-- `groups_sync_requested_at` ONLY - this statement never writes
-- `groups_next_sync_after`/`groups_last_synced_at` (those stay
-- worker-owned; `groups.errors.ts`'s own rate-limit path reads, never
-- writes, the clock). Zero rows means either a foreign/missing/deleted
-- instance, or a genuine rate-limit refusal - the caller (`groups-sync-
-- request.service.ts`) falls back to groups-sync-clock.sql to tell those
-- two cases apart.
UPDATE whatsapp_instances
   SET groups_sync_requested_at = now()
 WHERE id = $instance_id
   AND client_id = $client_id
   AND deleted_at IS NULL
   AND (groups_next_sync_after IS NULL OR groups_next_sync_after <= now())
RETURNING groups_sync_requested_at, groups_next_sync_after;
