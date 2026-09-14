-- P23 (broadcast-campaigns) Unit U1 - migration 0064.
-- ALTERs `campaigns` (the P03 migration 0010 DDL shell) - never CREATEs it
-- (P03's own header names this exact rule: "P23 owns `campaigns` logic
-- (broadcast lifecycle, snapshotting)" and must ALTER, not re-CREATE). Adds
-- the two new tables the scope delta's *Schema delta -> Broadcasts and
-- recipients* section names (`campaign_recipients`, `campaign_counters`),
-- the `broadcast_recipient_status` enum, and this session's gap-filling
-- decisions (recorded as an ADR at phase close):
--
--   - `campaigns` gains `instance_id` (the delta's DDL omitted the sending
--     account entirely), `name`, `created_by_user_id`, `idempotency_key`
--     (+ its own partial unique index) on top of every column the delta's
--     `ALTER TABLE campaigns` block lists (audience/message/target_kind/
--     priority/scheduled_at/both cursors/audience_count/price_key/
--     quote_minor/paused_by_user_id/cancel_reason). `status` already exists
--     (migration 0010) and is NOT re-added.
--   - `campaign_recipients` is deliberately NOT partitioned: it is a
--     uniqueness authority (`cr_campaign_target_uq`), and a UNIQUE index on
--     a partitioned table can only be enforced per-partition unless it
--     carries the partition key (same rule `message_jobs`/`delivery_events`
--     already live under - schema-assertions test 21).
--   - `campaign_counters` is the O(1) progress-rollup row, updated once per
--     BATCH by the expansion worker (P23 U4), never once per recipient row -
--     see this phase's "Risks / gotchas": per-row updates on this exact
--     table produced 500 dead tuples per batch on the row that also drives
--     the progress UI in an earlier design pass. `fillfactor=70` +
--     aggressive autovacuum on both `campaigns` and `campaign_counters`
--     exists for the same reason.
--   - `plan_limits.max_broadcast_recipients` (the 20,000 ceiling) and its
--     `effective_client_limits` view row ALREADY EXIST as of migration 0002/
--     0030 - nothing to add here. `client_limit_overrides.limit_key` is
--     plain `text` with no CHECK constraint (verified: migration 0030), so
--     no override-list extension is needed either.
--
-- REPO REALITY corrections this migration's header must carry forward for
-- the units that build on it (P23 U4/U5, ref-first expansion CTE):
--   (a) `mjr_dedupe_uq` (migration 0008) is a PARTIAL unique INDEX, not a
--       named constraint - `ON CONFLICT (client_id, instance_id, dedupe_key)
--       WHERE dedupe_key IS NOT NULL DO NOTHING`, never
--       `ON CONFLICT ON CONSTRAINT mjr_dedupe_uq` (Postgres cannot infer a
--       partial index from a constraint-name conflict target).
--   (b) `gen_uuid_v7()` does not exist in this database; `public_id` is
--       app-generated (`randomUUID()`), same convention `messages.repo.ts`
--       already uses.
--   (c) `message_jobs.id` is `GENERATED ALWAYS AS IDENTITY` (migration
--       0007) - a ref-first insert must pre-allocate ids from
--       `pg_get_serial_sequence('message_jobs','id')` and insert with
--       `OVERRIDING SYSTEM VALUE`.
--   (d) `message_job_refs.message_job_created_at` and the corresponding
--       `message_jobs.created_at` must be bound from the SAME in-SQL now()
--       value in the SAME statement/transaction - never a JS `Date` (ms)
--       bound into a `timestamptz` (us) column (the P21-carried precision
--       hazard named in this phase file's "Notes and deferred items").
--
-- RLS idiom on both new tables: ENABLE + FORCE + a `tenant_isolation`
-- policy, exactly migration 0060's shape. Neither table grants DELETE to any
-- role - the only DELETE path is P25's rate-limited retention batch
-- (db/src/retention.ts registers the policy; nothing here schedules it).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns) THEN
    RAISE EXCEPTION 'campaigns must be empty before migration 0064 - it was a DDL shell with no writer until this phase';
  END IF;
END;
$$;

CREATE TYPE broadcast_recipient_status AS ENUM (
  'pending',
  'skipped',
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'cancelled'
);

-- ---------------------------------------------------------------------
-- 1. campaigns - ALTER only (migration 0010 owns CREATE). `status` already
--    exists; every other column below is new.
-- ---------------------------------------------------------------------
ALTER TABLE campaigns
  ADD COLUMN instance_id uuid NOT NULL REFERENCES whatsapp_instances(id),
  ADD COLUMN name text NOT NULL,
  ADD COLUMN created_by_user_id uuid,
  ADD COLUMN idempotency_key text,
  ADD COLUMN audience jsonb NOT NULL,
  ADD COLUMN message jsonb NOT NULL,
  ADD COLUMN target_kind text NOT NULL DEFAULT 'contacts' CHECK (target_kind IN ('contacts', 'groups')),
  ADD COLUMN priority job_priority NOT NULL DEFAULT 'low',
  ADD COLUMN scheduled_at timestamptz,
  ADD COLUMN snapshot_cursor_contact_id uuid,
  ADD COLUMN snapshot_done_at timestamptz,
  ADD COLUMN expand_cursor_recipient_id bigint NOT NULL DEFAULT 0,
  ADD COLUMN expand_done_at timestamptz,
  ADD COLUMN audience_count int,
  ADD COLUMN price_key text,
  ADD COLUMN quote_minor bigint,
  ADD COLUMN paused_by_user_id uuid,
  ADD COLUMN cancel_reason text;

CREATE UNIQUE INDEX campaigns_client_idem_uq
  ON campaigns (client_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX campaigns_client_instance_status_idx
  ON campaigns (client_id, instance_id, status);

-- Deliberately global (does NOT lead with client_id): the snapshot/expansion
-- cron sweeps discover due work across every tenant's campaigns in one pass,
-- same class as `message_jobs_lease_expiry_idx`/`ils_stale_idx` - registered
-- in db/src/isolation/canonical-authority-keys.ts's CANONICAL_AUTHORITY_KEYS
-- (leading_column: status) alongside campaigns' existing primary_key entry.
CREATE INDEX campaigns_worker_discovery_idx
  ON campaigns (status, updated_at)
  WHERE status IN ('snapshotting', 'expanding');

ALTER TABLE campaigns SET (
  fillfactor = 80,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 50,
  autovacuum_analyze_scale_factor = 0.02
);

-- wp_scheduler needs write access: the snapshot/expansion workers (cron
-- role) advance campaigns.status/cursors/counters as they run.
GRANT SELECT, INSERT, UPDATE ON campaigns TO wp_scheduler;

-- ---------------------------------------------------------------------
-- 2. campaign_recipients - NOT partitioned (uniqueness authority). Already
--    the fourth SUITE_A_INDEX_EXEMPTIONS entry and a SEND_PATH_TABLES entry
--    (both registered ahead of this migration, P03/P07 dispatch text) - no
--    further registry edits needed for those two lists.
-- ---------------------------------------------------------------------
CREATE TABLE campaign_recipients (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id              uuid NOT NULL REFERENCES clients(id),
  campaign_id            uuid NOT NULL REFERENCES campaigns(id),
  contact_id             uuid REFERENCES contacts(id),
  group_id               uuid, -- NO FK yet: groups is P24
  recipient_jid          text NOT NULL,
  recipient_e164         text,
  recipient_hash         bytea NOT NULL,
  vars                   jsonb NOT NULL DEFAULT '{}'::jsonb, -- resolved AT SNAPSHOT TIME, frozen
  status                 broadcast_recipient_status NOT NULL DEFAULT 'pending',
  message_job_public_id  uuid,
  skip_reason            text,
  failure_class          text,
  queued_at              timestamptz,
  sent_at                timestamptz,
  delivered_at           timestamptz,
  read_at                timestamptz,
  terminal_at            timestamptz,
  charged_minor          bigint,
  CONSTRAINT cr_exactly_one_target CHECK ((contact_id IS NULL) <> (group_id IS NULL))
) WITH (fillfactor = 80);

CREATE UNIQUE INDEX cr_campaign_target_uq
  ON campaign_recipients (campaign_id, coalesce(contact_id, group_id));

CREATE INDEX cr_client_campaign_status_idx
  ON campaign_recipients (client_id, campaign_id, status);

-- The expansion worker's keyset cursor (batches of 500, ordered by id).
CREATE INDEX cr_campaign_cursor_idx
  ON campaign_recipients (campaign_id, id);

ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_recipients FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE campaign_recipients OWNER TO wp_migrator;

-- No DELETE grant to any role: the only delete path is P25's rate-limited
-- retention batch (db/src/retention.ts registers the 13-month policy this
-- migration exists alongside; P25 builds the deleter).
GRANT SELECT, INSERT, UPDATE ON campaign_recipients TO wp_app;
GRANT SELECT, INSERT, UPDATE ON campaign_recipients TO wp_scheduler;
GRANT SELECT ON campaign_recipients TO wp_admin_app;
GRANT USAGE ON SEQUENCE campaign_recipients_id_seq TO wp_app, wp_scheduler;

-- ---------------------------------------------------------------------
-- 3. campaign_counters - O(1) progress rollup, one row per campaign,
--    updated once per BATCH (never per recipient row - see header).
-- ---------------------------------------------------------------------
CREATE TABLE campaign_counters (
  campaign_id     uuid PRIMARY KEY REFERENCES campaigns(id),
  client_id       uuid NOT NULL REFERENCES clients(id),
  total           int NOT NULL DEFAULT 0,
  pending         int NOT NULL DEFAULT 0,
  skipped         int NOT NULL DEFAULT 0,
  queued          int NOT NULL DEFAULT 0,
  sent            int NOT NULL DEFAULT 0,
  delivered       int NOT NULL DEFAULT 0,
  read            int NOT NULL DEFAULT 0,
  failed          int NOT NULL DEFAULT 0,
  cancelled       int NOT NULL DEFAULT 0,
  charged_minor   bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  recomputed_at   timestamptz
) WITH (fillfactor = 70);

-- The table's only client_id-leading index (its PK is campaign_id).
CREATE INDEX campaign_counters_client_idx ON campaign_counters (client_id);

ALTER TABLE campaign_counters SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 50,
  autovacuum_analyze_scale_factor = 0.02
);

ALTER TABLE campaign_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_counters FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE campaign_counters OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE ON campaign_counters TO wp_app;
GRANT SELECT, INSERT, UPDATE ON campaign_counters TO wp_scheduler;
GRANT SELECT ON campaign_counters TO wp_admin_app;

-- ---------------------------------------------------------------------
-- 4. plan_limits.max_broadcast_recipients / effective_client_limits /
--    client_limit_overrides.limit_key - ALREADY DONE (migrations 0002,
--    0030). Nothing to add: verified live against the migrated dev DB while
--    writing this migration (plan_limits carries max_broadcast_recipients
--    int NOT NULL DEFAULT 20000 since migration 0002; the
--    effective_client_limits view already UNPIVOTs it since migration 0030;
--    client_limit_overrides.limit_key is plain text with no CHECK
--    constraint, so no key-list extension is needed for an override).
-- ---------------------------------------------------------------------
