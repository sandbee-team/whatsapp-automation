-- P14 (safe-mode-guards) Unit U1 - migration 0036. Forward-only,
-- additive-only. Nine new tables, zero ALTERs to any existing table
-- (message_jobs already carries recipient_hash/cancel_reason/send_origin/
-- content_fingerprint/content_fingerprint_counted_at/pacing_deny_reason/
-- pacing_deferrals/is_new_conversation - migration 0007/0024/0025/session-
-- open corrections; nothing added here).
--
-- WHY each table exists (safe-mode design SS6.2 + phase-file amendments):
--
--   opt_outs                    - the durable opt-out record, hashed phone
--     (hmac_sha256(pepper, e164)) + envelope-encrypted display value.
--     `scope` is 'client' or 'instance' and `scope_key` is the matching
--     client_id/instance_id, so ONE table serves both scopes without a
--     nullable-FK-pair shape. The partial unique index
--     `(client_id, scope_key, phone_hash) WHERE restored_at IS NULL` is the
--     "currently opted out" lookup authority - a restore (UPDATE
--     restored_at) frees the slot for a fresh opt-out row rather than
--     reusing/deleting the old one, preserving full history.
--   optout_confirmations        - "have we already sent this phone_hash its
--     30-day opt-out confirmation" - PK (client_id, scope_key, phone_hash),
--     survives a restore/re-opt-out cycle by design (no FK to opt_outs, see
--     header note below): the 30-day confirmation rule must not be resettable
--     by opting out again.
--   content_fingerprints        - CLIENT-level (blueprint amendment; the
--     safe-mode design's original instance-level PK is superseded) per-day
--     dedupe/fan-out-tracking row for one exact content fingerprint,
--     PK (client_id, local_date, fingerprint). `ack_by`/`ack_at` record a
--     staff/system acknowledgement of a fan-out warning.
--   content_fingerprint_recipients - which hashed recipients have already
--     received this exact fingerprint today - PK (client_id, local_date,
--     fingerprint, recipient_hash), the per-recipient half of the same
--     dedupe/fan-out surface.
--   recipient_send_buckets      - TRUE rolling-hour send-frequency counters,
--     PK (client_id, phone_hash, hour_bucket). Supersedes the safe-mode
--     design's daily-count `recipient_frequency` table (not created here).
--     `hour_bucket` contract (binding, later units depend on it verbatim):
--     hour_bucket = date_trunc('hour', <send time>), written by the
--     send-result transaction (a later unit) - never derived any other way.
--   tenant_optout_keywords      - per-tenant ADDITIONS to the platform
--     opt-out keyword list. The platform list itself lives in `@wp/domain`
--     CODE (never rows here), so no grant on this table can ever delete a
--     platform entry - deleting a tenant-added row can only ever narrow this
--     table's own additive contribution, never the platform floor.
--   tenant_blocked_words        - same additive-only shape as
--     tenant_optout_keywords, for the content-guard blocked-word list.
--   instance_recipient_contacts - phase-file prerequisite escape hatch: this
--     table did not exist yet (verified: no migration before 0036 creates
--     it), so this unit creates it here as instructed. Single source of
--     `is_new_conversation`/`first_inbound_at` for the pacing cold-outreach
--     classification - PK (client_id, instance_id, recipient_hash).
--
-- RLS - every table below carries client_id NOT NULL as its first column and
-- gets the canonical ENABLE + FORCE + `tenant_isolation` policy idiom from
-- migration 0020/0030.
--
-- GRANTS - wp_app gets read/write per the binding decisions below;
-- wp_admin_app is SELECT-only everywhere (BYPASSRLS platform-read surface,
-- same as every prior migration); wp_scheduler gets NO grant on any of these
-- nine tables - the guard pipeline reads them under wp_app in the claim
-- transaction (task instruction, deviation would need an ADR).
--
--   opt_outs: wp_app SELECT, INSERT, UPDATE - NO DELETE for any app role
--     (binding decision 2): an opt-out row outlives the contact; restore is
--     an UPDATE (restored_at/restored_by/restore_reason), never a DELETE.
--     No ON DELETE CASCADE from any other table references this one.
--   optout_confirmations: wp_app SELECT, INSERT, UPDATE (last_sent_at is
--     refreshed on every confirmation send) - no DELETE (the 30-day-window
--     record must persist across a restore/re-opt-out cycle, hence also no
--     FK to opt_outs).
--   content_fingerprints / content_fingerprint_recipients: wp_app SELECT,
--     INSERT, UPDATE (recipient_count/ack_by/ack_at are mutated in place) -
--     no DELETE (the fingerprint history is the audit trail for a fan-out
--     investigation).
--   recipient_send_buckets: wp_app SELECT, INSERT, UPDATE (the hourly
--     counter is incremented via UPSERT by the send-result transaction) - no
--     DELETE (old buckets simply age out of the rolling-window read window).
--   tenant_optout_keywords / tenant_blocked_words: wp_app SELECT, INSERT,
--     DELETE under RLS (binding decision 3) - a tenant may add or remove its
--     OWN additions; there is no UPDATE surface (a keyword/word is either
--     present or absent, never edited in place) and the platform floor is
--     code, not rows, so no grant here can ever narrow it.
--   instance_recipient_contacts: wp_app SELECT, INSERT, UPDATE (first/last
--     outbound and first inbound timestamps are updated in place per
--     contact) - no DELETE (per-contact erasure soft-deletes the owning
--     contact elsewhere; this table is not that authority).
--
-- INDEXES:
--   opt_outs_lookup           - the canonical DDL's partial unique index,
--     `(client_id, scope_key, phone_hash) WHERE restored_at IS NULL` -
--     already leads with client_id, so it also satisfies the "every tenant
--     table has >=1 client_id-leading index" rule; no separate index needed.
--   optout_confirmations      - PK (client_id, scope_key, phone_hash)
--     already leads with client_id; no separate index needed.
--   content_fingerprints      - PK (client_id, local_date, fingerprint)
--     already leads with client_id; no separate index needed.
--   content_fingerprint_recipients - PK (client_id, local_date, fingerprint,
--     recipient_hash) already leads with client_id; no separate index
--     needed.
--   recipient_send_buckets    - PK (client_id, phone_hash, hour_bucket)
--     already leads with client_id; no separate index needed.
--   tenant_optout_keywords / tenant_blocked_words - PK (client_id, ...)
--     already leads with client_id; no separate index needed.
--   instance_recipient_contacts - PK (client_id, instance_id,
--     recipient_hash) already leads with client_id; no separate index
--     needed.
--
-- Every PK below already leads with client_id, so NONE of these nine tables
-- needs a CANONICAL_AUTHORITY_KEYS entry (companion TS change registers them
-- in TENANT_TABLE_COVERAGE only).

-- =======================================================================
-- 1. opt_outs - per safe-mode design SS6.2, verbatim shape.
-- =======================================================================
CREATE TABLE opt_outs (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients(id),
  scope text NOT NULL CHECK (scope IN ('client', 'instance')),
  scope_key uuid NOT NULL,
  phone_hash bytea NOT NULL,
  phone_enc bytea NOT NULL,
  source text NOT NULL,
  matched_keyword text,
  origin_instance_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz,
  restored_by uuid,
  restore_reason text
);

CREATE UNIQUE INDEX opt_outs_lookup ON opt_outs (client_id, scope_key, phone_hash)
  WHERE restored_at IS NULL;

ALTER TABLE opt_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE opt_outs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON opt_outs FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE opt_outs OWNER TO wp_migrator;

-- No DELETE grant for any app role (binding decision 2).
GRANT SELECT, INSERT, UPDATE ON opt_outs TO wp_app;
GRANT SELECT ON opt_outs TO wp_admin_app;

-- =======================================================================
-- 2. optout_confirmations - survives a restore/re-opt-out cycle by design;
--    NO FK to opt_outs (binding decision 4).
-- =======================================================================
CREATE TABLE optout_confirmations (
  client_id uuid NOT NULL REFERENCES clients(id),
  scope_key uuid NOT NULL,
  phone_hash bytea NOT NULL,
  last_sent_at timestamptz NOT NULL,
  PRIMARY KEY (client_id, scope_key, phone_hash)
);

ALTER TABLE optout_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE optout_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON optout_confirmations FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE optout_confirmations OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE ON optout_confirmations TO wp_app;
GRANT SELECT ON optout_confirmations TO wp_admin_app;

-- =======================================================================
-- 3. content_fingerprints - CLIENT-level PK (blueprint amendment over the
--    safe-mode design's instance-level PK; no instance_id column).
-- =======================================================================
CREATE TABLE content_fingerprints (
  client_id uuid NOT NULL REFERENCES clients(id),
  local_date date NOT NULL,
  fingerprint bytea NOT NULL,
  recipient_count int NOT NULL DEFAULT 0,
  ack_by uuid,
  ack_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, local_date, fingerprint)
);

ALTER TABLE content_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_fingerprints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content_fingerprints FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE content_fingerprints OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE ON content_fingerprints TO wp_app;
GRANT SELECT ON content_fingerprints TO wp_admin_app;

-- =======================================================================
-- 4. content_fingerprint_recipients - per-recipient half of the same
--    dedupe/fan-out surface.
-- =======================================================================
CREATE TABLE content_fingerprint_recipients (
  client_id uuid NOT NULL REFERENCES clients(id),
  local_date date NOT NULL,
  fingerprint bytea NOT NULL,
  recipient_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, local_date, fingerprint, recipient_hash)
);

ALTER TABLE content_fingerprint_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_fingerprint_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content_fingerprint_recipients FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE content_fingerprint_recipients OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE ON content_fingerprint_recipients TO wp_app;
GRANT SELECT ON content_fingerprint_recipients TO wp_admin_app;

-- =======================================================================
-- 5. recipient_send_buckets - true rolling-hour counters. Supersedes the
--    safe-mode design's daily-count `recipient_frequency` table (not
--    created here - binding decision, see migration header).
--
--    hour_bucket CONTRACT (binding decision 1, normative for later units):
--    hour_bucket = date_trunc('hour', <send time>), written by the
--    send-result transaction.
-- =======================================================================
CREATE TABLE recipient_send_buckets (
  client_id uuid NOT NULL REFERENCES clients(id),
  phone_hash bytea NOT NULL,
  -- Contract: hour_bucket = date_trunc('hour', <send time>), written by the
  -- send-result transaction (a later unit) - never derived any other way.
  hour_bucket timestamptz NOT NULL,
  count int NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, phone_hash, hour_bucket)
);

ALTER TABLE recipient_send_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipient_send_buckets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recipient_send_buckets FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE recipient_send_buckets OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE ON recipient_send_buckets TO wp_app;
GRANT SELECT ON recipient_send_buckets TO wp_admin_app;

-- =======================================================================
-- 6. tenant_optout_keywords - additive-only relative to the platform list
--    (platform list lives in @wp/domain CODE, never rows here).
-- =======================================================================
CREATE TABLE tenant_optout_keywords (
  client_id uuid NOT NULL REFERENCES clients(id),
  keyword text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, keyword)
);

ALTER TABLE tenant_optout_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_optout_keywords FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_optout_keywords FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE tenant_optout_keywords OWNER TO wp_migrator;

-- wp_app may INSERT/SELECT/DELETE its own rows under RLS - deleting a
-- tenant-added keyword never loosens below the platform list (code, not
-- rows). No UPDATE surface (binding decision 3).
GRANT SELECT, INSERT, DELETE ON tenant_optout_keywords TO wp_app;
GRANT SELECT ON tenant_optout_keywords TO wp_admin_app;

-- =======================================================================
-- 7. tenant_blocked_words - additive-only relative to the platform list,
--    same shape as tenant_optout_keywords.
-- =======================================================================
CREATE TABLE tenant_blocked_words (
  client_id uuid NOT NULL REFERENCES clients(id),
  word text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, word)
);

ALTER TABLE tenant_blocked_words ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_blocked_words FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_blocked_words FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE tenant_blocked_words OWNER TO wp_migrator;

GRANT SELECT, INSERT, DELETE ON tenant_blocked_words TO wp_app;
GRANT SELECT ON tenant_blocked_words TO wp_admin_app;

-- =======================================================================
-- 8. instance_recipient_contacts - phase prerequisite escape hatch: did NOT
--    exist before this migration (verified against every migration
--    0001-0035); created here per the phase file's explicit instruction.
--    Single source of `is_new_conversation`/`first_inbound_at`.
-- =======================================================================
CREATE TABLE instance_recipient_contacts (
  client_id uuid NOT NULL REFERENCES clients(id),
  instance_id uuid NOT NULL REFERENCES whatsapp_instances(id),
  recipient_hash bytea NOT NULL,
  first_outbound_at timestamptz,
  last_outbound_at timestamptz,
  first_inbound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, instance_id, recipient_hash)
);

ALTER TABLE instance_recipient_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_recipient_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON instance_recipient_contacts FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE instance_recipient_contacts OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE ON instance_recipient_contacts TO wp_app;
GRANT SELECT ON instance_recipient_contacts TO wp_admin_app;
