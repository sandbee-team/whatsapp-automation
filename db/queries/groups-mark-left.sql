-- groups-mark-left.sql (P24 Unit U3, step 5) - worker-side (wp_scheduler)
-- conditional UPDATE marking one group's leave executed, AFTER
-- `groupSocket.groupLeave(group_jid)` has already returned successfully.
-- `left_at IS NULL` in the WHERE - idempotent: a row already marked left
-- matches zero rows on a repeat call rather than re-stamping `updated_at`.
UPDATE wa_groups
   SET left_at = now(),
       updated_at = now()
 WHERE id = $id
   AND client_id = $client_id
   AND left_at IS NULL;
