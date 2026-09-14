-- groups-get-leave-requested-at.sql (P24 Unit U3, step 5) - the idempotent
-- replay read for `POST /v1/groups/:id/leave`: when
-- groups-request-leave.sql's conditional UPDATE matches zero rows because
-- `leave_requested_at` was already set, this reads the EXISTING timestamp so
-- the route can return the SAME value with no second audit row. Excludes a
-- group that has already left entirely (`left_at IS NOT NULL`) - the caller
-- treats that, and a genuinely missing id, both as `GroupNotFoundError`.
SELECT leave_requested_at
  FROM wa_groups
 WHERE id = $id
   AND client_id = $client_id
   AND left_at IS NULL;
