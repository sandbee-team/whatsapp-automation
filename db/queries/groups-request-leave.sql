-- groups-request-leave.sql (P24 Unit U3, step 5) - the ONE conditional
-- UPDATE that requests a group leave: always allowed (de-escalation, never
-- refused), idempotent via `leave_requested_at IS NULL` in the WHERE - a
-- second call matches zero rows here, and the caller falls back to
-- groups-get-leave-requested-at.sql to return the SAME timestamp without a
-- second audit row (see groups.service.ts's own doc comment).
UPDATE wa_groups
   SET leave_requested_at = now(),
       send_enabled = false,
       disabled_reason = 'leave_requested',
       updated_at = now()
 WHERE id = $id
   AND client_id = $client_id
   AND left_at IS NULL
   AND leave_requested_at IS NULL
RETURNING leave_requested_at;
