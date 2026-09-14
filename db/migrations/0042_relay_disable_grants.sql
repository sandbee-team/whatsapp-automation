-- P15 (outbox-relay-and-webhooks) Unit U5 - migration 0042. Forward-only,
-- additive-only: no existing table/column/policy/grant touched, no new
-- table/role created.
--
-- Migration 0041 granted `wp_relay` (NOLOGIN BYPASSRLS) SELECT/UPDATE/DELETE
-- on `outbox_events` and SELECT/INSERT/UPDATE on `webhook_deliveries`, plus
-- SELECT + a column-scoped UPDATE on `webhook_endpoints` - but the webhook
-- dispatcher's auto-disable-at-20 path (phase step 7's design) needs TWO
-- more things 0041 did not anticipate:
--
--   1. `INSERT` on `outbox_events` - the disabled endpoint fires a
--      `webhook.endpoint_disabled` event via `modules/events/emit.ts`'s
--      `emit()`, which INSERTs the outbox row itself (0041 only granted
--      wp_relay SELECT/UPDATE/DELETE - the disable path is the first wp_relay
--      caller that ever WRITES a fresh outbox row rather than only
--      claiming/publishing existing ones).
--   2. `INSERT` on `audit_logs` - "Terminal failure ... an audit_logs row"
--      (phase step 7, verbatim). 0041 did not grant wp_relay anything on
--      `audit_logs` at all (migration 0013 granted it to wp_app only, plus
--      wp_warmup in migration 0034 for its own definer-function path).
--
-- ACCESS CONVENTION: follows 0041's own precedent exactly - wp_relay is a
-- session-connectable-shaped role granted directly on tables (not a
-- SECURITY DEFINER function, unlike the wp_reaper/wp_warmup precedent),
-- because its actual call shape is ordinary `SET LOCAL ROLE wp_relay` + ad
-- hoc SQL across an evolving set of statements (0041's own header, verbatim
-- reasoning, reused here for the SAME role rather than re-litigated).
-- Both grants below are narrow (INSERT only) - wp_relay still has no
-- SELECT/UPDATE/DELETE on `audit_logs` (an append-only write is all the
-- disable path ever needs) and its `outbox_events` INSERT is additive to
-- its existing SELECT/UPDATE/DELETE from 0041, not a widening of what it can
-- already do to those rows once written.

GRANT INSERT ON outbox_events TO wp_relay;
GRANT INSERT ON audit_logs TO wp_relay;

-- ---------------------------------------------------------------------
-- 3. wp_app DELETE on webhook_endpoints (phase step 8's `DELETE
--    /v1/webhook-endpoints` route). 0041 deliberately withheld this ("no
--    DELETE granted here by default caution ... a later unit can widen if
--    the panel needs a hard delete") - step 8 is that later unit: the
--    endpoint CRUD surface explicitly includes a hard delete, so the
--    caution is resolved by granting it narrowly (this table only, no
--    change to any other 0041 grant).
-- ---------------------------------------------------------------------
GRANT DELETE ON webhook_endpoints TO wp_app;
