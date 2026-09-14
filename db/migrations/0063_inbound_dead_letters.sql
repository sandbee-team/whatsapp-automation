-- P21 (inbound-listener-receipts-and-optout) Unit U1 - migration 0063. Two
-- objects, no body path: inbound_dead_letters (ids and hashes only) and
-- whatsapp_instances.inbound_max_per_minute. v2 owns the inbox body path
-- (chats, messages, media_assets); this migration must never grow a body
-- column.
--
-- inbound_dead_letters is bounded by design: a dead letter is rare (only a
-- throwing inbound handler writes one, per event, in its own transaction -
-- phase step 7), so it is deliberately NOT partitioned, same "small,
-- naturally-bounded" precedent as send_attempts (migration 0008) and
-- webhook_deliveries (migration 0041) rather than message_jobs/
-- delivery_events. `id` is a bigint GENERATED ALWAYS AS IDENTITY surrogate
-- row handle only - a dead letter is an event record, replays are allowed
-- by design (ADR 0021), so it carries no uniqueness authority and needs a
-- CANONICAL_AUTHORITY_KEYS entry (same class as outbox_events, migration
-- 0041) rather than a SUITE_A_INDEX_EXEMPTIONS slot. `client_id` is the
-- first column after `id` (core invariant 4 / database.md); one index,
-- `inbound_dead_letters_client_idx`, leads with client_id, instance_id,
-- created_at DESC - the only read path this table needs (a tenant's/
-- instance's recent dead letters).
--
-- No body column, no `payload`, no `snippet`, no `preview` - ever.
-- `wa_msg_id` is an id, not content; `chat_jid_hash` is a hash, not a JID;
-- `raw_size` is a byte count, not the bytes. `error_class` is a short,
-- non-freeform classification tag (the catch's error name / a fixed
-- vocabulary), never `err.message` or any provider-detail string (core
-- invariant 6 / ADR 0021 - a pg error's `detail`/`where` can carry row
-- values, so only `err.name` + the pg `code`, never the message itself,
-- may ever reach this table).
--
-- RLS + grants idiom: ENABLE + FORCE + the standard `tenant_isolation`
-- policy, exactly migration 0058's `topup_requests` shape. `wp_app` gets
-- SELECT + INSERT (the inbound handler writes its own dead letter) plus a
-- column-scoped UPDATE(replayed_at) only (a future replay tool marks a row
-- replayed; it never touches any other column) - no DELETE for anyone but
-- wp_migrator (retention/purge is a later phase's concern, not this one's).
-- `wp_admin_app` gets SELECT only (staff/ops visibility).
--
-- IDENTITY SEQUENCE GRANT: verified against this schema's own precedent -
-- outbox_events (migration 0041, also a bigint GENERATED ALWAYS AS IDENTITY
-- PK) grants `wp_app` only SELECT/INSERT on the table itself and grants NO
-- sequence privilege at all, because an identity column's DEFAULT
-- (nextval() on its owned sequence) is evaluated under the table/sequence
-- owner's privileges (wp_migrator, migration 0005's ownership transfer),
-- not the inserting role's - Postgres only requires an explicit sequence
-- GRANT when a role calls nextval()/currval() directly, which no code path
-- here does. staff_audit_log (migration 0058) is the same shape and also
-- grants no sequence privilege. No sequence GRANT is added below; the
-- schema test `inbound_dead_letters_leads_with_client_id_and_is_rls_forced`
-- proves a plain `INSERT ... (client_id, instance_id, error_class)` succeeds
-- as wp_app without one.
--
-- Suite-A registration: `inbound_dead_letters` -> `TENANT_TABLE_COVERAGE`
-- (client_id NOT NULL); its PK is registered in `CANONICAL_AUTHORITY_KEYS`
-- instead of `SUITE_A_INDEX_EXEMPTIONS` (that list stays exactly three -
-- campaign_recipients, wallet_charge_guards, contact_import_errors).
--
-- whatsapp_instances.inbound_max_per_minute: the per-instance inbound
-- admission ceiling read by modules/inbound/admission.ts (phase step 6).
-- Platform-set - there is no tenant write path in v1 (a tenant-settable
-- value that LOOSENS a limit would be a forbidden provider-evasion
-- mechanism, core invariant 6); the column is additive and tightening-only
-- by convention, enforced by there being no route that writes it. wp_app's
-- existing grants on whatsapp_instances are column-scoped (migrations 0021/
-- 0023), so a new column is NOT automatically covered - SELECT is added
-- explicitly below (no UPDATE grant: platform-set only).

CREATE TABLE inbound_dead_letters (      -- bounded; ids and hashes only, never a body
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id     uuid NOT NULL REFERENCES clients(id),
  instance_id   uuid NOT NULL REFERENCES whatsapp_instances(id),
  wa_msg_id     text,
  chat_jid_hash bytea,
  error_class   text NOT NULL,
  raw_size      int,
  replayed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbound_dead_letters_raw_size_non_negative
    CHECK (raw_size IS NULL OR raw_size >= 0)
);

CREATE INDEX inbound_dead_letters_client_idx
  ON inbound_dead_letters (client_id, instance_id, created_at DESC);

ALTER TABLE inbound_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_dead_letters FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inbound_dead_letters FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE inbound_dead_letters OWNER TO wp_migrator;

GRANT SELECT, INSERT ON inbound_dead_letters TO wp_app;
GRANT UPDATE (replayed_at) ON inbound_dead_letters TO wp_app;
GRANT SELECT ON inbound_dead_letters TO wp_admin_app;

ALTER TABLE whatsapp_instances
  ADD COLUMN inbound_max_per_minute int NOT NULL DEFAULT 120
    CHECK (inbound_max_per_minute > 0);

GRANT SELECT (inbound_max_per_minute) ON whatsapp_instances TO wp_app;
