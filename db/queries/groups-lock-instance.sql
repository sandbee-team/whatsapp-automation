-- groups-lock-instance.sql (P24 C2 fix round, Fix 1) - serialises concurrent
-- `PATCH /v1/groups/:id/send-enabled` enables for the SAME instance but
-- DIFFERENT groups. `groups-get.sql`'s own `FOR UPDATE` only locks the one
-- target group row, so two concurrent enables against two different groups
-- of the same instance never contend on any row and both can read the same
-- stale `groups-other-enabled-devices-total.sql` sum under READ COMMITTED
-- (the device-budget race). Locking the tenant's instance row FIRST, inside
-- the same transaction, gives every enable for that instance a single
-- serialization point: the second transaction to reach this statement
-- blocks until the first COMMITs (or ROLLBACKs), and therefore observes the
-- first one's already-applied `send_enabled` total.
SELECT id
  FROM whatsapp_instances
 WHERE id = $instance_id
   AND client_id = $client_id
   AND deleted_at IS NULL
 FOR UPDATE;
