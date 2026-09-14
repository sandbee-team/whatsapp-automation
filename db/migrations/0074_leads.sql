-- P29 (website-and-launch-hardening) step 5, Unit U4a. Non-tenant marketing
-- lead row written by admin/backend's public endpoint (blueprint [R-52]): no
-- client exists yet when a visitor submits the marketing site's contact
-- form, so this table intentionally carries no client_id and is registered
-- in ISOLATION_NON_TENANT_TABLES ('marketing lead, no tenant exists yet'),
-- never in TENANT_TABLE_COVERAGE - same non-tenant idiom as migration 0070's
-- staff_users/staff_sessions.
--
-- ip_hash is NEVER a raw IP address - it is an HMAC-SHA256 hex digest (64
-- lowercase hex chars) computed by the write path before the row is
-- inserted; the CHECK constraint below rejects anything else at the storage
-- layer, so an application bug cannot silently persist a raw IP.
--
-- Every free-text field is capped at the storage layer (name/company/
-- message/source/utm all carry an explicit CHECK) so an application bug
-- cannot store an unbounded body - core invariant 3's "idempotency/
-- invariants at the storage layer" extended to size bounds, same discipline
-- as migration 0070's impersonation_grants duration CHECKs.
--
-- Grants: SELECT + INSERT for wp_admin_app only - no UPDATE, no DELETE, and
-- no grant at all for any other role (wp_app/wp_scheduler/wp_relay/
-- wp_reaper/wp_warmup/wp_migrator-beyond-ownership). Leads are appended by
-- the public endpoint, reviewed by staff, and expire by retention policy -
-- never edited in place, so no UPDATE grant exists even for wp_admin_app.
-- `id` is a uuid (gen_random_uuid() default), so there is no owned sequence
-- to grant USAGE on, unlike a bigint identity column.
CREATE TABLE leads (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  email        citext NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  company      text CHECK (char_length(company) <= 120),
  phone_e164   text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  message      text CHECK (char_length(message) <= 2000),
  source       text NOT NULL CHECK (source ~ '^[a-z0-9-]{1,64}$'),
  utm          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(utm) = 'object' AND pg_column_size(utm) <= 2048),
  ip_hash      text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leads_pkey PRIMARY KEY (id)
);

CREATE INDEX leads_created_at_idx ON leads (created_at DESC);

ALTER TABLE leads OWNER TO wp_migrator;

GRANT SELECT, INSERT ON leads TO wp_admin_app;
