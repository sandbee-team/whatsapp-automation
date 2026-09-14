-- groups-get.sql (P24 Unit U3, step 4/5) - reads ONE `wa_groups` row by id,
-- client_id-scoped, `FOR UPDATE` so `groups.service.ts`'s enable/disable
-- path can lock the row before its conditional UPDATE in the same
-- transaction. A left group (`left_at IS NOT NULL`) is NOT excluded here -
-- the caller (setGroupSendEnabled) treats a left row as
-- `GroupNotFoundError` itself, same "read then classify" shape
-- `broadcasts.repo.ts` uses for its own transition read.
SELECT id, client_id, instance_id, subject, participant_count, is_announce,
       our_role, send_enabled, send_enabled_at, disabled_reason,
       tracked_participant_devices, last_synced_at, last_message_at,
       leave_requested_at, left_at
  FROM wa_groups
 WHERE id = $id
   AND client_id = $client_id
 FOR UPDATE;
