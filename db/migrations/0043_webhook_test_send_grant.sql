-- P15 C1 FIX F3 (MAJ-1) - migration 0043. Forward-only, additive-only: no
-- existing table/column/policy/grant touched, no new table/role created.
--
-- `POST /v1/webhooks/endpoints/:id/test` (routes.ts) INSERTs directly into
-- `webhook_deliveries` under `wp_app` (the tenant-scoped RLS role every
-- ordinary API request runs as) - but migration 0041 only granted `wp_app`
-- SELECT on that table ("read-only delivery history for the panel ... never
-- writes this table directly"), because at the time 0041 was written the
-- ONLY writer of `webhook_deliveries` was ever expected to be `wp_relay`
-- (the dispatcher's own durable retry state). The `/test` route is a
-- genuine SECOND writer this schema did not anticipate: a tenant manually
-- triggering a synthetic delivery to prove their endpoint is reachable,
-- authenticated + RLS-scoped exactly like every other `wp_app` write. Without
-- this grant the route's INSERT fails with a Postgres permission error in
-- ANY environment that actually enforces `wp_app`'s grants (only the dev/test
-- superuser pool masked this, since it bypasses grants entirely) - dead in
-- production.
--
-- COLUMN-SCOPED, not a blanket table-level INSERT: `wp_app` gets exactly the
-- columns the route's own INSERT statement names (routes.ts, verbatim) -
-- `client_id, outbox_event_id, endpoint_id, event_type, payload_hash, status,
-- next_attempt_at` - never `attempt`/`status_code`/`error_class`/
-- `updated_at` (those stay `wp_relay`-only, the dispatcher's own retry-state
-- columns, untouched by this grant). Matches the column-scoped-grant
-- discipline `wp_reaper`/`wp_relay` already establish elsewhere in this
-- schema (migration 0027, 0041/0042) - narrow by construction, not by
-- promise.

GRANT INSERT (client_id, outbox_event_id, endpoint_id, event_type, payload_hash, status, next_attempt_at)
  ON webhook_deliveries TO wp_app;
