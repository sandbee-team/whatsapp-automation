-- P15 (outbox-relay-and-webhooks) Unit U1 - migration 0041. Forward-only,
-- additive-only: no existing table/column/policy/grant touched.
--
-- Three new tables:
--   outbox_events      - the durable fan-out work queue (relay's own claim
--                         scope, drained + deleted, never a history table).
--   webhook_endpoints   - per-tenant webhook subscription config.
--   webhook_deliveries  - the webhook dispatcher's own durable retry state
--                         (phase step 7's design, built into this migration
--                         now per the task instruction).
--
-- DEVIATION FROM DESIGN SS6.4 (stated here, ADR to be written by the main
-- session at phase close, per the task instruction): `webhook_deliveries` is
-- NON-PARTITIONED in v1. Design SS6.4 does not mandate partitioning for this
-- table, but the phase task explicitly calls out the deviation reasoning:
-- its uniqueness authority `UNIQUE (outbox_event_id, endpoint_id)` cannot
-- live on a partitioned table without a second authority table (a unique
-- index on a partitioned table must carry the partition key - same
-- constraint `message_jobs`/`delivery_events` document at every partitioned
-- table in this schema, migrations 0007/0009), and volume here is bounded by
-- subscribed endpoints x subscribed events, not by total message volume -
-- `send_attempts` (migration 0008) is the direct precedent for "small,
-- naturally-bounded, NOT partitioned, retention by DELETE".
--
-- STATUS/ERROR-CLASS SHAPE: `text` + CHECK, not a new Postgres enum -
-- `db/tests/enum-parity.test.ts` compares the live `public` schema's enums
-- against `@wp/domain`'s `PG_ENUMS` manifest, which lives in `packages/`,
-- outside this unit's file scope (see the phase task's file-scope list).
-- Migration 0036's `opt_outs.scope`/`pacing_events.kind` set this exact
-- precedent (text + CHECK, deferring an enum promotion to whichever unit
-- owns `packages/domain`) - followed here unchanged. `webhook_deliveries.
-- status` values mirror this schema's existing queue-state vocabulary
-- (`message_jobs.status`: 'queued' while eligible to be worked, a terminal
-- 'sent'/'failed' pair) rather than inventing new verbs: 'pending' (queued
-- to be attempted, mirrors message_jobs' 'queued'), 'sent' (2xx delivered),
-- 'failed' (terminal, non-retryable class or MAX_ATTEMPTS exhausted).
--
-- ACCESS CONVENTION (relay/dispatcher cross-tenant claim + write): follows
-- the `wp_reaper` precedent (migration 0027) exactly, not the read-only
-- `wp_admin_app`-definer precedent - both `outbox_events` and
-- `webhook_deliveries` need a cross-tenant WRITE (claim via UPDATE ...
-- SKIP LOCKED, then a further UPDATE/DELETE on the same rows), and
-- `wp_admin_app` must never hold a write grant on any of these tables. A
-- dedicated NOLOGIN BYPASSRLS role, `wp_relay`, is created here and granted
-- table-level SELECT/UPDATE/DELETE on `outbox_events` and SELECT/INSERT/
-- UPDATE on `webhook_deliveries` (INSERT: the dispatcher writes its own
-- `pending` row before the HTTP call, phase step 7's design - it is not a
-- read-only sweep like the reconciler). `wp_relay` also gets UPDATE on
-- `webhook_endpoints.consecutive_failures`/`last_success_at`/
-- `disabled_reason`/`enabled` (column-scoped, the health-tracking columns
-- the dispatcher writes) plus SELECT on the table (it must read `url`/
-- `secret_enc`/`events`/`enabled`/`include_message_body` to do its job).
-- This unit does NOT write `db/queries/claim-outbox.sql` (later unit's file)
-- - only the grant/role surface that makes it possible, per the task
-- instruction. Unlike wp_reaper (whose only reachable object is
-- message_jobs/send_attempts via one definer function), wp_relay is a
-- session-connectable-shaped role (still NOLOGIN, never an actual login)
-- granted directly on these three tables rather than via a definer function,
-- because the relay's actual claim query (later unit) needs ordinary
-- `SET LOCAL ROLE wp_relay` + ad hoc SQL, not a single fixed RPC shape - the
-- reaper's single hand-rolled UPDATE fits a definer function; a relay that
-- polls, batches, coalesces and marks `published_at`/`suppressed_by` across
-- an evolving set of statements does not.
--
-- SEND_PATH_TABLES is not edited: outbox_events/webhook_deliveries are
-- fan-out/notification state, never the send path itself (message_jobs never
-- transitions based on anything written here) - wp_admin_app's no-write
-- invariant on the actual send path is untouched and irrelevant to this
-- migration.

-- ---------------------------------------------------------------------
-- 0. wp_relay role - NOLOGIN, BYPASSRLS (same idempotent creation shape as
--    every other role in this schema, migrations 0005/0027).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wp_relay') THEN
    CREATE ROLE wp_relay NOLOGIN;
  END IF;
END;
$$;

ALTER ROLE wp_relay BYPASSRLS;
GRANT USAGE ON SCHEMA public TO wp_relay;

-- ---------------------------------------------------------------------
-- 1. outbox_events - the fan-out work queue. Non-partitioned (drained and
--    deleted, not history - the task's own instruction). FILLFACTOR 70:
--    every row is written once then updated in place (published_at/
--    suppressed_by/attempts), same HOT-update rationale as pacing_ledger
--    (migration 0030) and instance_lease_state (migration 0018).
-- ---------------------------------------------------------------------
CREATE TABLE outbox_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id      uuid NOT NULL,
  instance_id    uuid,
  event_type     text NOT NULL,
  entity_id      text NOT NULL,
  payload        jsonb NOT NULL,
  coalesce_key   text,
  fanout         text[] NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  suppressed_by  bigint,
  attempts       smallint NOT NULL DEFAULT 0,
  -- Payload size ceiling: ids-only, never a message body - enforced at the
  -- storage layer (core invariant: idempotency/limits belong in the
  -- database, not only application code). pg_column_size includes the
  -- jsonb's own varlena header, so this is a slightly stricter bound than a
  -- raw 1024-byte text length, which is the intent (headroom for the
  -- envelope, not an invitation to fill it with a body).
  CONSTRAINT outbox_events_payload_size CHECK (pg_column_size(payload) <= 1024),
  -- fanout is a subset of {sse, webhook} - never empty, never any other
  -- label. array <@ enforces both the membership AND the "no unknown label"
  -- direction; a separate cardinality check keeps it non-empty.
  CONSTRAINT outbox_events_fanout_subset CHECK (fanout <@ ARRAY['sse', 'webhook']::text[]),
  CONSTRAINT outbox_events_fanout_nonempty CHECK (cardinality(fanout) > 0),
  -- An SSE-fanned event with no coalesce_key cannot exist: SSE delivery
  -- coalesces by key (the realtime channel dedupes/collapses by
  -- coalesce_key, per this unit's own test); a row that fans out to sse
  -- with no key to coalesce on is a storage-layer-rejected shape, not an
  -- application-only validation.
  CONSTRAINT outbox_events_sse_requires_coalesce_key
    CHECK ('sse' <> ALL(fanout) OR coalesce_key IS NOT NULL)
) WITH (fillfactor = 70);

-- Dispatcher/relay claim scan: unpublished rows only, oldest first via id.
CREATE INDEX outbox_events_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;

-- Per-tenant recency browse (dashboard/audit read path).
CREATE INDEX outbox_events_client_created_idx ON outbox_events (client_id, created_at);

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON outbox_events FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE outbox_events OWNER TO wp_migrator;

-- wp_app: the API/worker path that WRITES outbox rows (an event is created
-- alongside whatever business write triggers it) - INSERT + SELECT, no
-- UPDATE/DELETE (only the relay ever transitions published_at/attempts/
-- suppressed_by or deletes a drained row).
GRANT SELECT, INSERT ON outbox_events TO wp_app;
-- wp_admin_app: platform read surface only, same as every other tenant table.
GRANT SELECT ON outbox_events TO wp_admin_app;
-- wp_relay: the fan-out relay's cross-tenant claim/publish/cleanup surface -
-- SELECT to read+claim, UPDATE for published_at/suppressed_by/attempts,
-- DELETE for the bounded cleanup sweep (task's own description: "bounded
-- cleanup DELETEs").
GRANT SELECT, UPDATE, DELETE ON outbox_events TO wp_relay;

-- ---------------------------------------------------------------------
-- 2. webhook_endpoints - per-tenant webhook subscription config, per design
--    SS6.4 plus the two columns this migration is told to add now:
--    `include_message_body` (phase step 8, no API to flip it in v1) and
--    `disabled_reason` carrying 'consecutive_failures' (phase step 7's
--    auto-disable-at-20 design).
-- ---------------------------------------------------------------------
-- id is an app-generated uuidv7 surrogate (same convention as every other
-- uuid PK in this schema - whatsapp_instances/campaigns/pacing_events etc.,
-- see CANONICAL_AUTHORITY_KEYS's own comments - no DB-side default here,
-- matching that precedent exactly).
CREATE TABLE webhook_endpoints (
  id                     uuid NOT NULL PRIMARY KEY,
  client_id              uuid NOT NULL,
  url                    text NOT NULL,
  secret_enc             bytea NOT NULL,
  events                 text[] NOT NULL,
  enabled                boolean NOT NULL DEFAULT true,
  include_message_body   boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_success_at        timestamptz,
  consecutive_failures   smallint NOT NULL DEFAULT 0,
  disabled_reason        text,
  CONSTRAINT webhook_endpoints_events_nonempty CHECK (cardinality(events) > 0),
  CONSTRAINT webhook_endpoints_disabled_reason_shape
    CHECK (disabled_reason IS NULL OR disabled_reason IN ('consecutive_failures', 'manual'))
) WITH (fillfactor = 70);

CREATE INDEX webhook_endpoints_client_idx ON webhook_endpoints (client_id);

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON webhook_endpoints FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE webhook_endpoints OWNER TO wp_migrator;

-- wp_app: the tenant's own CRUD surface over their webhook subscriptions
-- (create/list/enable/disable/rotate secret) - no DELETE granted here by
-- default caution (matches the opt_outs/clients precedent of narrow-by-
-- default; a later unit can widen if the panel needs a hard delete).
GRANT SELECT, INSERT, UPDATE ON webhook_endpoints TO wp_app;
GRANT SELECT ON webhook_endpoints TO wp_admin_app;
-- wp_relay: reads subscription config to decide fanout targets, and writes
-- ONLY the health-tracking columns the dispatcher owns (never url/secret_enc/
-- events/include_message_body - those stay wp_app-only).
GRANT SELECT ON webhook_endpoints TO wp_relay;
GRANT UPDATE (last_success_at, consecutive_failures, disabled_reason, enabled)
  ON webhook_endpoints TO wp_relay;

-- ---------------------------------------------------------------------
-- 3. webhook_deliveries - the webhook dispatcher's durable retry state
--    (phase step 7's design, built now). NON-partitioned - see this file's
--    header deviation note. `UNIQUE (outbox_event_id, endpoint_id)` is the
--    uniqueness authority: one delivery row per (event, subscribed
--    endpoint) pair, ever - the dispatcher's own claim/retry loop updates
--    this ONE row in place rather than inserting a fresh attempt row per
--    retry (mirrors message_jobs' own "one row per unit of work, updated in
--    place across retries" shape, not send_attempts' "one row per attempt"
--    shape - the design's column list per SS6.4 has no attempt-history
--    columns, only a single current `attempt`/`status_code`/`error_class`,
--    confirming the single-row-per-pair authority).
-- ---------------------------------------------------------------------
CREATE TABLE webhook_deliveries (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id        uuid NOT NULL,
  outbox_event_id  bigint NOT NULL,
  endpoint_id      uuid NOT NULL,
  event_type       text NOT NULL,
  payload_hash     bytea NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  attempt          smallint NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  status_code      smallint,
  error_class      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outbox_event_id, endpoint_id),
  CONSTRAINT webhook_deliveries_status_shape CHECK (status IN ('pending', 'sent', 'failed')),
  -- MAX_ATTEMPTS=8 (phase step 7 canon) - a structural ceiling matching the
  -- documented cap, same "database row enforces the floor/ceiling, not only
  -- TypeScript" discipline core invariant 6 (mechanical conventions) requires.
  CONSTRAINT webhook_deliveries_attempt_ceiling CHECK (attempt >= 0 AND attempt <= 8)
) WITH (fillfactor = 70);

-- Dispatcher claim scan: due, still-pending rows only.
CREATE INDEX webhook_deliveries_claim_idx
  ON webhook_deliveries (status, next_attempt_at)
  WHERE status = 'pending';

-- Per-tenant delivery history browse (dashboard/audit read path).
CREATE INDEX webhook_deliveries_client_created_idx ON webhook_deliveries (client_id, created_at);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON webhook_deliveries FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE webhook_deliveries OWNER TO wp_migrator;

-- wp_app: read-only delivery history for the panel (a tenant viewing their
-- own webhook delivery log) - never writes this table directly.
GRANT SELECT ON webhook_deliveries TO wp_app;
GRANT SELECT ON webhook_deliveries TO wp_admin_app;
-- wp_relay: the dispatcher's own durable state - INSERT (write the pending
-- row before the HTTP call, phase step 7's design), SELECT (claim scan +
-- the self-read a status/attempt UPDATE needs), UPDATE (record the
-- attempt's outcome). No DELETE: delivery rows are retained as history,
-- unlike outbox_events.
GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO wp_relay;
