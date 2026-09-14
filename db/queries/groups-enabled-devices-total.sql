-- groups-enabled-devices-total.sql (P24 Unit U3, step 4) - the instance's
-- CURRENT total tracked-participant-devices across every send-enabled,
-- non-left group. Used by the list route (`budget.trackedDevicesEnabledTotal`
-- and each row's `canSendToGroup` input) - a single tenant- and instance-
-- scoped aggregate, never a raw participant projection (counts only).
SELECT coalesce(sum(tracked_participant_devices), 0)::int AS total
  FROM wa_groups
 WHERE client_id = $client_id
   AND instance_id = $instance_id
   AND send_enabled = true
   AND left_at IS NULL;
