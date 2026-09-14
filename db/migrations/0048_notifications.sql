-- P17 (notifications-and-instance-card) Unit U1 - migration 0048.
-- Forward-only, additive-only: no existing table dropped/retyped; the one
-- ALTER below (outbox_events_fanout_subset) only WIDENS an existing CHECK's
-- legal set, same DROP+ADD idiom migrations 0038/0044 already established
-- for a CHECK constraint (no ALTER-in-place form exists for CHECK).
--
-- ONE new table, `notifications` - the mandatory-notification authority the
-- blueprint's "real-time & notifications" section requires: every kind in
-- packages/domain/src/notifications/kinds.ts (a later unit) is
-- `mandatory: true` with no suppression path, and dedupe for a reconnect
-- storm (40 disconnect/reconnect cycles collapsing to 1 notification) is
-- enforced HERE, at the unique constraint, never in application code
-- (core invariant 3) - `notifications_dedupe_uq UNIQUE (client_id,
-- dedupe_key)` is the single dedupe authority; `notify()` (a later unit)
-- INSERTs ... ON CONFLICT ON CONSTRAINT notifications_dedupe_uq DO NOTHING
-- and fans out from that statement's RETURNING, never a pre-check read.
--
-- NON-PARTITIONED (phase task's own instruction, verbatim): this is
-- per-tenant notification volume, not total message volume - the same
-- "small, naturally-bounded, NOT partitioned, retention by DELETE" class as
-- send_attempts/webhook_deliveries/instance_health_samples, not the
-- message_jobs/delivery_events partitioned-by-volume class. No retention
-- query is added by this unit (not asked for; unlike migration 0044's
-- instance_health_samples, the phase task names no retention cadence for
-- notifications - a read/unread inbox is retained, not swept).
--
-- ID CONVENTION: `id uuid PRIMARY KEY` with NO db-side default, matching
-- every other uuid-PK "row handle, not a uniqueness authority" table in this
-- tree (whatsapp_instances/campaigns/pacing_events/webhook_endpoints/
-- instance_health_samples - see migrations 0002/0022/0030/0041/0044's own
-- header comments: ids are app-generated uuidv7, uuid PKs get no DB
-- default). `notifications.id` follows this unchanged - it is a row handle
-- (dedupe is the UNIQUE constraint, not the PK), so it takes no default
-- here, consistent with every sibling table's precedent, not a deviation.
--
-- TWO indexes, deliberately not one - see the CREATE INDEX block below for
-- why both the partial (unread) and full (list) index are needed.
--
-- ACCESS: wp_app (SELECT, INSERT; UPDATE restricted to the three
-- read/resolve columns), wp_admin_app (SELECT, standard platform read
-- surface), wp_scheduler (INSERT - the health evaluator/guard pipeline is
-- itself a caller of notify(), same "wp_scheduler writes its own evidence
-- rows" class as pacing_events/instance_health_samples; SELECT is also
-- granted since notify()'s ON CONFLICT DO NOTHING RETURNING requires no
-- extra grant beyond INSERT, but the later in-app API's own read path
-- reasonably shares wp_scheduler's write connection in some call shapes -
-- granted narrowly, matching the wp_app pair exactly), and wp_relay
-- (SELECT only, on `notifications` alone - the email relay leg renders the
-- email body from the notification row, phase step 4). wp_relay's grant
-- surface is DELIBERATELY NOT widened to `memberships`/`users`: see the
-- WP_RELAY GAP note below - this is a reported gap, not silently worked
-- around.
--
-- WP_RELAY GAP (reported to the main session, per this unit's dispatch):
-- the phase's step-4 email dispatcher (a LATER unit,
-- app/backend/src/modules/notifications/dispatch/email.ts) resolves
-- recipients from `memberships` (role owner|admin) joined to `users`
-- (email, email-verified state) to render the "who gets this email"
-- recipient list. This migration does NOT grant wp_relay any access to
-- `memberships`/`users`: `db/tests/wp-relay-role.test.ts`'s
-- `wp_relay_has_no_grant_on_any_table_beyond_the_four_it_owns` test pins
-- wp_relay's ENTIRE grant surface to EXACTLY four tables (audit_logs,
-- outbox_events, webhook_deliveries, webhook_endpoints) - migration 0046's
-- own header already refused to widen this surface for an unrelated P16
-- need ("wp_relay is deliberately minimal ... and must never gain a grant
-- on a fifth table"), and the same discipline applies here: adding
-- `notifications` already grows that pinned set to five, and adding
-- `memberships`/`users` on top would grow it further and cross into
-- identity-table access this role was never scoped for. The email
-- dispatcher's actual recipient-resolution query, when U3/U4 build it,
-- needs an explicit decision from whoever owns that unit: either read
-- recipients under `wp_app`'s existing grant (`wp_app` already has
-- read access to its own tenant's memberships/users via the ordinary
-- session-scoped role, migration 0005) and hand the resolved list to the
-- relay rather than letting the relay query identity tables itself, or a
-- narrowly-scoped new definer function/role. This unit only grants what
-- the phase task's OWN step-1 instruction lists (SELECT on notifications) -
-- it does not pre-empt that later design choice.

-- =======================================================================
-- 1. Enums: notification_kind, notification_severity.
-- =======================================================================
CREATE TYPE notification_kind AS ENUM (
  'instance_paused',
  'instance_logged_out',
  'reconnect_budget_exhausted',
  'duplicate_fanout_ack_required',
  'unresolved_send',
  'plan_cap_reached',
  'infra_unavailable',
  'warmup_tier_changed'
);

CREATE TYPE notification_severity AS ENUM (
  'info',
  'warning',
  'critical'
);

-- =======================================================================
-- 2. notifications - non-partitioned, dedupe-by-constraint (see header).
-- =======================================================================
CREATE TABLE notifications (
  id                   uuid PRIMARY KEY,
  client_id            uuid NOT NULL REFERENCES clients(id),
  instance_id          uuid REFERENCES whatsapp_instances(id),
  kind                 notification_kind NOT NULL,
  severity             notification_severity NOT NULL,
  dedupe_key           text NOT NULL,
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  requires_user_action boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  read_at              timestamptz,
  read_by_user_id      uuid REFERENCES users(id),
  resolved_at          timestamptz,
  CONSTRAINT notifications_dedupe_uq UNIQUE (client_id, dedupe_key),
  -- Payload size ceiling, same discipline as outbox_events_payload_size
  -- (migration 0041): the payload carries ids/enums/counts only, never a
  -- message body - a storage-layer-enforced PII boundary, not only an
  -- application-side convention.
  CONSTRAINT notifications_payload_size CHECK (pg_column_size(payload) <= 2048)
);

-- Unread inbox (dashboard bell/badge query): partial index, read_at IS NULL
-- rows only - small and hot, the query this index exists for never wants a
-- read notification in its result set at all.
CREATE INDEX notifications_unread_idx
  ON notifications (client_id, created_at DESC, id DESC)
  WHERE read_at IS NULL;

-- Full per-client timeline (keyset list endpoint, GET /v1/notifications, no
-- OFFSET - phase step 6): reads read AND unread rows in one keyset scan, so
-- the partial index above (which excludes read rows entirely) cannot serve
-- it - a second, non-partial index with the identical column list is the
-- correct shape, not a redundant duplicate of the one above.
CREATE INDEX notifications_list_idx
  ON notifications (client_id, created_at DESC, id DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON notifications FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE notifications OWNER TO wp_migrator;

-- wp_app: the in-app API's own read/write surface (list/unread-count/mark
-- read/mark-all-read, phase step 6) - INSERT covers notify()'s own write
-- path when called from an wp_app-connected request handler; UPDATE is
-- restricted to exactly the three columns a "mark read"/"resolve" action
-- ever touches - never kind/severity/dedupe_key/payload, which are
-- write-once at INSERT time.
GRANT SELECT, INSERT ON notifications TO wp_app;
GRANT UPDATE (read_at, read_by_user_id, resolved_at) ON notifications TO wp_app;

-- wp_admin_app: platform read surface, standard across this schema.
GRANT SELECT ON notifications TO wp_admin_app;

-- wp_scheduler: notify() is also called from background/evaluator paths
-- (health evaluator, guard pipeline, warmup evaluator - all already
-- wp_scheduler-connected callers per migrations 0030/0034/0044) - same
-- SELECT+INSERT pair as wp_app, no UPDATE (only the in-app API resolves a
-- notification on the user's behalf).
GRANT SELECT, INSERT ON notifications TO wp_scheduler;

-- wp_relay: SELECT only - the email relay leg renders the email body from
-- the notification row (phase step 4). See the WP_RELAY GAP header note for
-- why memberships/users are deliberately NOT granted here.
GRANT SELECT ON notifications TO wp_relay;

-- =======================================================================
-- 3. outbox_events.fanout - widen the CHECK to add 'email' (P17 adds an
--    email relay channel; a notification's fan-out writes one outbox row
--    per channel, so 'email' must be a legal fanout member). DROP+ADD is
--    the only additive path for a CHECK constraint (migrations 0038/0044
--    precedent) - the constraint's name is unchanged since migration 0041's
--    original CREATE TABLE. outbox_events_fanout_nonempty and the
--    sse-coalesce-key CHECK (outbox_events_sse_requires_coalesce_key) are
--    untouched.
-- =======================================================================
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_fanout_subset;

-- fanout is a subset of {sse, webhook, email} - never empty, never any
-- other label. array <@ enforces both the membership AND the "no unknown
-- label" direction; outbox_events_fanout_nonempty (untouched) keeps the
-- separate non-empty requirement.
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_fanout_subset
  CHECK (fanout <@ ARRAY['sse', 'webhook', 'email']::text[]);
