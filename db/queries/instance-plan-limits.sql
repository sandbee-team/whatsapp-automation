-- instance-plan-limits.sql (P08 Unit U6c; P28 U3b step 5 adds the staff
-- limit-override read-through) - reads the calling client's own effective
-- registered/connected instance caps. Returns zero rows when the client has
-- no plan assigned (`plan_id IS NULL`) or the plan row is missing - the
-- caller treats that as fail-closed (deny/zero-capacity), never as
-- "unlimited" (core invariant 2).
--
-- P28 U3b: a staff `PUT /internal/v1/clients/:id/limits` override on
-- `max_registered_instances`/`max_connected_instances` must be honoured HERE
-- too, exactly as `modules/contacts/contacts-limits.ts#
-- resolveEffectiveMaxContacts` and `modules/broadcasts/limits.ts#
-- resolveEffectiveMaxBroadcastRecipients` already honour their own keys -
-- otherwise an operator raising a client's instance cap would see it apply
-- to contacts and broadcasts but silently NOT to instance provisioning.
-- Same COALESCE shape and the same `(expires_at IS NULL OR expires_at >
-- now())` guard as those two readers, so a NULL value (a soft clear - there
-- is no DELETE grant on `client_limit_overrides`) or an elapsed expiry both
-- fall back to the plan value.

-- name: instance-plan-limits
SELECT COALESCE(
         (SELECT o.limit_value FROM client_limit_overrides o
           WHERE o.client_id = c.id AND o.limit_key = 'max_registered_instances'
             AND (o.expires_at IS NULL OR o.expires_at > now())),
         pl.max_registered_instances
       ) AS max_registered_instances,
       COALESCE(
         (SELECT o.limit_value FROM client_limit_overrides o
           WHERE o.client_id = c.id AND o.limit_key = 'max_connected_instances'
             AND (o.expires_at IS NULL OR o.expires_at > now())),
         pl.max_connected_instances
       ) AS max_connected_instances
  FROM clients c
  JOIN plan_limits pl ON pl.plan_id = c.plan_id
 WHERE c.id = $client_id
 -- client_id = id = $client_id (clients' own PK IS the tenant id - same
 -- scanner precedent as provisioning.repo.ts's insertClient); the two
 -- correlated subqueries above are scoped by `o.client_id = c.id`, which is
 -- that same tenant id.
;
