-- groups-other-enabled-devices-total.sql (P24 Unit U3, step 5) - the
-- `PATCH .../send-enabled` enable path's `trackedDevicesOtherEnabledGroups`
-- input to `canEnableGroupSend`: the sum of `tracked_participant_devices`
-- over every OTHER send-enabled, non-left group of the SAME instance
-- (`id <> $id` excludes the group being enabled itself - its own devices are
-- added back by the caller as `groupTrackedDevices`, never double counted).
SELECT coalesce(sum(tracked_participant_devices), 0)::int AS total
  FROM wa_groups
 WHERE client_id = $client_id
   AND instance_id = $instance_id
   AND id <> $id
   AND send_enabled = true
   AND left_at IS NULL;
