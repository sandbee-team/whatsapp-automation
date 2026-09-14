-- groups-set-send-enabled.sql (P24 Unit U3, step 5) - the ONE conditional
-- UPDATE that flips `send_enabled` (a user-actor toggle, never a
-- signal-driven write). `left_at IS NULL` in the WHERE - a group that has
-- left cannot be (re)enabled/disabled; the caller treats a zero-row result
-- as `GroupNotFoundError` (already covered by the earlier FOR UPDATE read
-- classifying left_at, but the predicate stays here too - conditional
-- UPDATE, never a blind write, core invariant 3).
UPDATE wa_groups
   SET send_enabled = $enable,
       send_enabled_at = CASE WHEN $enable THEN now() ELSE send_enabled_at END,
       send_enabled_by_user_id = CASE WHEN $enable THEN $user_id::uuid ELSE send_enabled_by_user_id END,
       disabled_reason = CASE WHEN $enable THEN NULL ELSE 'disabled_by_user' END,
       updated_at = now()
 WHERE id = $id
   AND client_id = $client_id
   AND left_at IS NULL
RETURNING id, instance_id, subject, participant_count, is_announce, our_role,
          send_enabled, send_enabled_at, disabled_reason, tracked_participant_devices,
          last_synced_at, last_message_at, leave_requested_at;
