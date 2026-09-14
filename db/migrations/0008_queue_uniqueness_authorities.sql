-- P03 (db-queue-and-claim) - migration 0008.
-- The non-partitioned uniqueness authorities that sit alongside the
-- partitioned `message_jobs`/`delivery_events` tables (a UNIQUE index on a
-- partitioned table can only ever be per-partition-unique unless it carries
-- the partition key - see test 21 - so every authority that must be
-- GLOBALLY unique lives here instead, exactly like wallet_ledger_ext_refs
-- does for wallet_ledger in migration 0004).
--
-- Delta enums this phase's canonical-enum list requires to exist:
-- `broadcast_status`/`msg_direction`/`chat_kind` (see
-- `db/schema/enums.ts`/`packages/domain/src/enums/index.ts`). `job_status`,
-- `job_kind`, `attempt_state`, `wa_health`, `wa_link_state`, `pause_reason`
-- and `wallet_state` already exist as of migration 0001 - nothing to add
-- for those.

CREATE TYPE broadcast_status AS ENUM (
  'draft',
  'scheduled',
  'snapshotting',
  'expanding',
  'running',
  'paused',
  'completed',
  'cancelled',
  'failed'
);

CREATE TYPE msg_direction AS ENUM ('in', 'out');

-- v2 inbox/chat concept (ADR 0021) - created now only because it is on this
-- phase's canonical-enum checklist; nothing in P03 references it yet. Label
-- set is a best-guess placeholder (not specified verbatim anywhere this
-- migration's author could read) - flagged in the P03 session report for
-- confirmation when the inbox feature actually lands.
CREATE TYPE chat_kind AS ENUM ('individual', 'group');

-- ---------------------------------------------------------------------
-- message_job_refs - API idempotency + content dedupe. The ONLY id ever
-- exposed outside the database is `public_id` (app-generated uuidv7 - no DB
-- default, matching the uuid-PK convention set in migration 0002).
-- ---------------------------------------------------------------------
CREATE TABLE message_job_refs (
  public_id                 uuid PRIMARY KEY,
  client_id                 uuid NOT NULL,
  instance_id                uuid NOT NULL,
  message_job_id             bigint NOT NULL,
  message_job_created_at     timestamptz NOT NULL,
  idempotency_key             text,
  dedupe_key                  text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mjr_idem_uq
  ON message_job_refs (client_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX mjr_dedupe_uq
  ON message_job_refs (client_id, instance_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

ALTER TABLE message_job_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_job_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_job_refs FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE message_job_refs OWNER TO wp_migrator;

-- Append-only (an idempotency/dedupe record is never rewritten): SELECT +
-- INSERT only, no UPDATE/DELETE, on both roles that may create a job (the
-- API and, for worker-originated jobs such as retries, the scheduler).
GRANT SELECT, INSERT ON message_job_refs TO wp_app, wp_scheduler;
GRANT SELECT ON message_job_refs TO wp_admin_app;

-- ---------------------------------------------------------------------
-- message_wa_ids - created directly in its FINAL merged shape (blueprint
-- correction item 1, resolved by the scope delta): the SINGLE uniqueness
-- authority for both inbound and outbound provider message ids. v1 writes
-- `direction = 'out'` rows only; the `direction = 'in'` half and the two
-- `inbox_*` columns belong to v2's inbox product (ADR 0021) - present here
-- only so P21 has nothing to invent and nothing to ALTER.
-- ---------------------------------------------------------------------
CREATE TABLE message_wa_ids (
  client_id                    uuid NOT NULL,
  instance_id                  uuid NOT NULL,
  direction                    msg_direction NOT NULL DEFAULT 'out',
  wa_msg_id                    text NOT NULL,
  message_id                   bigint, -- NULLABLE: not every wa_msg_id row traces back to a message_jobs row (e.g. inbound, v2)
  message_created_at           timestamptz,
  inbox_message_id             bigint, -- v2 inbox (ADR 0021) - unused by v1
  inbox_message_created_at     timestamptz, -- v2 inbox (ADR 0021) - unused by v1
  PRIMARY KEY (client_id, instance_id, direction, wa_msg_id)
);

ALTER TABLE message_wa_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_wa_ids FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_wa_ids FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE message_wa_ids OWNER TO wp_migrator;

-- v1's only writer is the send worker (wp_scheduler), recording the
-- provider wa_msg_id after a successful dispatch. wp_app gets SELECT only
-- (no v1 caller needs it yet; kept for future read paths).
GRANT SELECT, INSERT ON message_wa_ids TO wp_scheduler;
GRANT SELECT ON message_wa_ids TO wp_app;
GRANT SELECT ON message_wa_ids TO wp_admin_app;

-- ---------------------------------------------------------------------
-- delivery_event_ids - webhook/provider-event dedupe authority for
-- `delivery_events` (migration 0009), inserted FIRST in the same
-- transaction as the corresponding delivery_events row (comment repeated
-- there). PK is the provider's own id, not client_id - it is the same
-- "globally-unique foreign id as PK" shape as message_job_refs.public_id,
-- not the tenant-root shape `clients.id` uses. Judgment call: this table is
-- registered in db/src/isolation/tenant-tables.ts's TENANT_TABLE_COVERAGE
-- (it IS a client-scoped, RLS-enforced table - client_id is NOT NULL and
-- carries the tenant_isolation policy below) even though its PK does not
-- lead with client_id and it is not one of the three fixed
-- SUITE_A_INDEX_EXEMPTIONS names - db/tests/isolation-suite-a.test.ts's
-- "every index leads with client_id" rule will need extending (by whichever
-- phase owns that file's next edit) to accommodate this shape; not fixed in
-- this migration. See the session report for the full list of tables this
-- affects (it is not just this one).
-- ---------------------------------------------------------------------
CREATE TABLE delivery_event_ids (
  provider_event_id          text PRIMARY KEY,
  client_id                  uuid NOT NULL,
  message_job_id             bigint,
  message_job_created_at     timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now()
);

-- Tenant-scoped lookback (admin/ops browsing, and the tenant-index-leads-
-- with-client_id rule this migration's PK legitimately cannot satisfy - see
-- the judgment-call comment above).
CREATE INDEX delivery_event_ids_client_idx ON delivery_event_ids (client_id, created_at DESC);

ALTER TABLE delivery_event_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_event_ids FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON delivery_event_ids FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE delivery_event_ids OWNER TO wp_migrator;

-- Append-only dedupe record; either the worker (send-result webhooks
-- relayed through the scheduler) or the API (direct provider webhooks) may
-- be the actual writer depending on how P03 Unit B/later phases wire the
-- webhook path - both roles get SELECT+INSERT so neither blocks that design
-- choice; no UPDATE/DELETE ever.
GRANT SELECT, INSERT ON delivery_event_ids TO wp_app, wp_scheduler;
GRANT SELECT ON delivery_event_ids TO wp_admin_app;

-- ---------------------------------------------------------------------
-- send_attempts - NOT partitioned (small, retention by DELETE, per the
-- canon), so `UNIQUE (message_job_id, attempt_no)` is a real, global
-- constraint. `attempt_state`'s actual labels (migration 0001) are
-- `prepared, dispatched, acked, failed, reconciled_sent, reconciled_lost,
-- abandoned` - there is no `unknown` label, so the "in flight / needs a
-- reconcile sweep" partial index below uses `('dispatched', 'abandoned')`
-- in place of the `('dispatched', 'unknown')` shorthand in the dispatch
-- text (this is the exact substitution that text called for).
-- ---------------------------------------------------------------------
CREATE TABLE send_attempts (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id              uuid NOT NULL,
  instance_id            uuid NOT NULL,
  message_job_id         bigint NOT NULL,
  message_job_created_at timestamptz NOT NULL,
  lease_id               uuid,
  owner_fence            bigint,
  attempt_no             smallint NOT NULL,
  content_hash            bytea,
  client_msg_id           text,
  state                  attempt_state NOT NULL DEFAULT 'prepared',
  provider_msg_id         text,
  error_class             text,
  prepared_at             timestamptz,
  dispatched_at            timestamptz,
  resolved_at              timestamptz,
  UNIQUE (message_job_id, attempt_no)
);

-- In-flight / needs-reconcile sweep.
CREATE INDEX send_attempts_inflight_idx
  ON send_attempts (client_id, instance_id, state, dispatched_at)
  WHERE state IN ('dispatched', 'abandoned');

-- Content-hash dedupe lookback within an instance.
CREATE INDEX send_attempts_content_hash_idx
  ON send_attempts (instance_id, content_hash)
  WHERE state IN ('dispatched', 'abandoned');

-- Attempt trail lookup by (job, lease) - reconcile/audit path.
CREATE INDEX send_attempts_job_lease_idx
  ON send_attempts (message_job_id, lease_id);

ALTER TABLE send_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON send_attempts FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE send_attempts OWNER TO wp_migrator;

-- The only table in this migration that is genuinely mutable (state
-- transitions prepared -> dispatched -> acked/failed, and retention sweeps
-- DELETE old rows) - wp_scheduler (the worker's role) owns its full
-- lifecycle; wp_app gets read-only access for dashboards/audit.
GRANT SELECT, INSERT, UPDATE, DELETE ON send_attempts TO wp_scheduler;
GRANT SELECT ON send_attempts TO wp_app;
GRANT SELECT ON send_attempts TO wp_admin_app;
