-- group-send-lookup.sql (P24 groups-messaging, Unit U4a, step 6) - the ONE
-- read `resolveGroupForEnqueue` (`app/backend/src/modules/groups/
-- send-lookup.ts`) runs at message-enqueue time for a `@g.us` recipient,
-- inside the caller's existing `withTenant` transaction (the SAME
-- transaction `createMessage` already opened - see `messages.service.ts`).
--
-- BIND PARAMETERS: named binds, first-occurrence order as `loadQuery`
-- derives it: client_id, instance_id, group_jid.
--
-- Returns AT MOST ONE row (`wa_groups` has a `UNIQUE (client_id, instance_id,
-- group_jid)` constraint, migration 0066) - zero rows means "never synced",
-- which the caller treats identically to `NOT_SEND_ENABLED`.
--
-- `enabled_devices_total` is the SUM of `tracked_participant_devices` across
-- every OTHER send-enabled, non-left group on the SAME instance - this is
-- `canSendToGroup`'s own `trackedDevicesInstanceTotal` input (already
-- includes this group's own tracked devices when `g.send_enabled` is true,
-- per that function's own doc comment). The correlated subquery carries its
-- own `client_id =`/`instance_id =` predicate (tenant isolation,
-- `scripts/check-tenant-scope.ts`) independently of the outer statement's.
--
-- `instance_pacing_state` is LEFT JOINed (never INNER) so a not-yet-
-- provisioned instance still returns the `wa_groups` row with a null
-- `eff_group_daily_cap` - the caller treats a null cap as `0` (fail-closed,
-- core invariant 2), never as "unlimited".
SELECT
  g.id,
  g.send_enabled,
  g.is_announce,
  g.our_role,
  g.tracked_participant_devices,
  g.left_at,
  s.eff_group_daily_cap,
  (
    SELECT COALESCE(SUM(e.tracked_participant_devices), 0)
      FROM wa_groups e
     WHERE e.client_id = $client_id
       AND e.instance_id = $instance_id
       AND e.send_enabled
       AND e.left_at IS NULL
  ) AS enabled_devices_total
  FROM wa_groups g
  LEFT JOIN instance_pacing_state s
    ON s.instance_id = g.instance_id AND s.client_id = g.client_id
 WHERE g.client_id = $client_id
   AND g.instance_id = $instance_id
   AND g.group_jid = $group_jid;
