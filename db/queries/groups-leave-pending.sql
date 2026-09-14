-- groups-leave-pending.sql (P24 Unit U3, step 5; P24 C2 fix round, Fix 5)
-- worker-side (wp_scheduler) discovery of this instance's own rows with a
-- pending leave request not yet executed. Tenant + instance scoped (the
-- caller already knows both from its own owned-instance loop) - answered by
-- `wa_groups_pending_idx` (migration 0066). `ORDER BY leave_requested_at
-- ASC, id ASC` before the `LIMIT` makes a batch that cannot drain
-- everything in one tick deterministic: the OLDEST requests are always
-- picked up first, so the remainder is guaranteed picked up on the very
-- next tick (never starved by an arbitrary/unstable row order) - `id ASC`
-- breaks ties between requests made in the same instant.
SELECT id, group_jid
  FROM wa_groups
 WHERE client_id = $client_id
   AND instance_id = $instance_id
   AND leave_requested_at IS NOT NULL
   AND left_at IS NULL
 ORDER BY leave_requested_at ASC, id ASC
 LIMIT $limit;
