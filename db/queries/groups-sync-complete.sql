-- groups-sync-complete.sql (P24 Unit U3, step 4) - worker-side (wp_scheduler)
-- clock update marking one instance's group sync complete: advances
-- `groups_last_synced_at`/`groups_next_sync_after` (the minimum-interval
-- gate every future sync request checks) and clears
-- `groups_sync_requested_at` (the request this sync just satisfied).
-- `$min_interval_ms` is `GROUP_SYNC_MIN_INTERVAL_MS` (@wp/domain) converted
-- to seconds for `make_interval` - never a second, hand-derived constant.
UPDATE whatsapp_instances
   SET groups_last_synced_at = now(),
       groups_next_sync_after = now() + make_interval(secs => $min_interval_ms / 1000.0),
       groups_sync_requested_at = NULL
 WHERE id = $instance_id
   AND client_id = $client_id;
