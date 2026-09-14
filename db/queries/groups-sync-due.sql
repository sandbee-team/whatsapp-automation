-- groups-sync-due.sql (P24 Unit U3, step 4) - the per-worker groups-sync
-- timer's own due-check for ONE currently-owned instance, run under the
-- normal `tenantDb.withTenant($client_id, ...)` transaction (never a
-- cross-tenant batched scan - `whatsapp_instances`/`wa_groups` carry only
-- the standard `tenant_isolation` policy keyed on `app.client_id`, no
-- `app.worker_id`-keyed policy the way `instance_lease_state` has for lease
-- renewal, so a batched multi-tenant statement here would see zero rows
-- under RLS with no single client_id GUC to scope to). The caller
-- (`session-groups-sync-timer.ts`) loops its own registry handles - each of
-- which already carries `clientId` - and calls this once per handle; that
-- loop is bounded by the worker's own in-memory session count, never
-- unbounded. Returns exactly one row (`due` boolean) - never zero, so the
-- caller distinguishes "not due" from "instance not found" if ever needed.
--
-- Due when: the sync clock has elapsed (`groups_next_sync_after IS NULL OR
-- <= now()`) AND EITHER a sync was explicitly requested OR at least one
-- group needs one (send-enabled, or itself flagged `next_sync_after` by the
-- forbidden hook).
SELECT (
  i.groups_next_sync_after IS NULL OR i.groups_next_sync_after <= now()
) AND (
  i.groups_sync_requested_at IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM wa_groups g
     WHERE g.instance_id = i.id
       AND g.client_id = i.client_id
       AND g.left_at IS NULL
       AND (g.send_enabled OR g.next_sync_after IS NOT NULL)
  )
) AS due
  FROM whatsapp_instances i
 WHERE i.id = $instance_id
   AND i.client_id = $client_id
   AND i.deleted_at IS NULL;
