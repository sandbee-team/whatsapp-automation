-- groups-sync-clock.sql (P24 Unit U3c) - the read-fallback for
-- `groups-request-sync.sql`'s zero-row case: distinguishes a genuinely
-- missing/foreign/deleted instance (no row here -> 404) from an in-window
-- rate-limit refusal (a row, with `groups_next_sync_after` in the future ->
-- 429 naming `retryAfterSeconds`). SELECT-only, no role change needed
-- (migration 0066 already grants `wp_app` SELECT on this column).
SELECT groups_next_sync_after
  FROM whatsapp_instances
 WHERE id = $instance_id
   AND client_id = $client_id
   AND deleted_at IS NULL;
