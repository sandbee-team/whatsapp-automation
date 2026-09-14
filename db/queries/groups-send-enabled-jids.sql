-- groups-send-enabled-jids.sql (P24 Unit U4b, step 8) - the ONE read behind
-- `send-enabled-jids.ts#createSendEnabledGroupJidsProvider`'s background
-- refresh: every `wa_groups.group_jid` this instance currently has send
-- enabled for, scoped by (client_id, instance_id) (core invariant 4 - tenant
-- isolation) and excluding a left group (`left_at IS NULL` - a group we left
-- is never send-eligible regardless of its stored `send_enabled` flag).
--
-- `LIMIT 5000` (mechanical convention: every list query carries a LIMIT) -
-- ADR 0018's structural per-instance group count never approaches this in
-- v1; a future instance with more enabled groups than the limit degrades to
-- "some enabled groups' messages are filtered as if not enabled" rather than
-- an unbounded query, which is the correct fail-safe direction for this
-- allow-list (never over-admit).
--
-- Returns bare `group_jid` text values - never a subject, participant, or
-- any other group-shaped PII (this table stores counts only, see migration
-- 0066's own header).

-- name: groups-send-enabled-jids
SELECT group_jid
  FROM wa_groups
 WHERE client_id = $client_id
   AND instance_id = $instance_id
   AND send_enabled
   AND left_at IS NULL
 LIMIT 5000;
