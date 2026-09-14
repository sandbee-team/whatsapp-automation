-- groups-mark-missing-left.sql (P24 Unit U3, step 4) - worker-side
-- (wp_scheduler): any row of this instance NOT present in the just-fetched
-- group set (`$jids`) is marked left - we are no longer a participant.
-- `group_jid <> ALL($jids)` with an EMPTY `$jids` array correctly marks every
-- row left (an instance that fetched zero participating groups this pass is
-- in every group listed here no longer).
UPDATE wa_groups
   SET left_at = now(),
       send_enabled = false,
       disabled_reason = 'not_participant',
       updated_at = now()
 WHERE client_id = $client_id
   AND instance_id = $instance_id
   AND left_at IS NULL
   AND group_jid <> ALL($jids::text[]);
