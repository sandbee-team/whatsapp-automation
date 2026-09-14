-- P20 (contacts-and-import) Unit U1 - migration 0060. Six client-scoped
-- tables: `contacts`, `contact_tags`, `contact_tag_links`, `contact_imports`,
-- `contact_import_errors`, `consent_records` - plus four new enums and
-- `plan_limits.max_contacts` / `clients.country_code`.
--
-- `consent_records` (and the `consent_basis` enum) is created HERE, not in
-- P02, because P02 never created it - this is the documented prerequisite
-- escape hatch (plan/v1/P20-contacts-and-import.md "Prerequisites"): never a
-- second consent table. Likewise `clients.country_code` does not exist yet
-- (added below, char(2) NOT NULL DEFAULT 'IN', consistent with the existing
-- `clients.timezone` default of 'Asia/Kolkata').
--
-- `contacts.opt_out_state` is a MIRROR ONLY, never the gate: the opt-out
-- AUTHORITY is `opt_outs` (migration 0036, P14 safe-mode-guards) and its
-- partial unique lookup index. This column is written exclusively by
-- `optout-mirror.ts` (a later P20 unit) inside the same transaction as the
-- `opt_outs` insert/restore - never by an import's `DO UPDATE` list. Reading
-- this column to gate a send would be a second, driftable authority and is
-- forbidden by design (core invariant 3 / database.md).
--
-- `contacts_client_phone_uq` is a PARTIAL unique index (`WHERE deleted_at IS
-- NULL`), so every upsert against it MUST repeat `WHERE deleted_at IS NULL`
-- in its `ON CONFLICT` clause - Postgres cannot infer a partial index from a
-- plain `ON CONFLICT (client_id, phone_e164)` and raises "there is no unique
-- or exclusion constraint matching the ON CONFLICT specification" otherwise.
--
-- RLS idiom (all six tables): ENABLE + FORCE + a `tenant_isolation` policy,
-- exactly migration 0058's shape. `wp_relay` and `wp_scheduler` get NO grant
-- on any of these six tables.
--
-- Suite-A registration: all six -> `TENANT_TABLE_COVERAGE` (client_id NOT
-- NULL). `contact_import_errors` is the pre-existing third
-- `SUITE_A_INDEX_EXEMPTIONS` entry (its PK is (import_id, row_no), not
-- client_id-leading, and this is its sole exemption - it needs no
-- CANONICAL_AUTHORITY_KEYS entry). `contacts`, `contact_tags`,
-- `contact_imports`, `consent_records` have surrogate uuid PKs (not
-- client_id-leading) and are registered in CANONICAL_AUTHORITY_KEYS instead,
-- same class as `topup_requests`/`webhook_endpoints`. `contact_tag_links`'
-- PK (client_id, tag_id, contact_id) already leads with client_id and needs
-- no entry.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE TYPE contact_source        AS ENUM ('import','inbound','manual','api');
CREATE TYPE contact_opt_out_state AS ENUM ('none','opted_out');
CREATE TYPE contact_import_status AS ENUM ('uploaded','validating','importing','done','failed','cancelled');
CREATE TYPE consent_basis         AS ENUM ('user_declared_optin','imported_with_attestation','inbound_initiated');

ALTER TABLE clients ADD COLUMN country_code char(2) NOT NULL DEFAULT 'IN';
ALTER TABLE plan_limits ADD COLUMN max_contacts int NOT NULL DEFAULT 25000;

-- ---------------------------------------------------------------------
-- 1. contacts - the tenant's address book.
-- ---------------------------------------------------------------------
CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id),
  phone_e164    text NOT NULL,                          -- normalised at write time, never as typed
  phone_hash    bytea NOT NULL,                         -- hmac_sha256(pepper, e164); joins opt_outs + recipient_send_buckets
  wa_jid        text NOT NULL,                          -- '<digits>@s.whatsapp.net', DERIVED, never user-supplied
  addressing_mode text NOT NULL DEFAULT 'pn' CHECK (addressing_mode IN ('pn','lid')),
  lid_jid       text,                                   -- persisted only when the provider supplies a lid<->pn mapping
  display_name  text, first_name text, last_name text,
  attrs         jsonb NOT NULL DEFAULT '{}'::jsonb
                CONSTRAINT contacts_attrs_max_2048 CHECK (octet_length(attrs::text) <= 2048),
  source        contact_source NOT NULL,
  consent_basis consent_basis,
  import_id     uuid,
  opt_out_state contact_opt_out_state NOT NULL DEFAULT 'none',   -- MIRROR ONLY, never the gate
  opted_out_at  timestamptz,
  last_inbound_at timestamptz, last_outbound_at timestamptz,
  created_by_user_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
CREATE UNIQUE INDEX contacts_client_phone_uq ON contacts (client_id, phone_e164) WHERE deleted_at IS NULL;
CREATE INDEX contacts_client_updated_idx    ON contacts (client_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX contacts_client_optout_idx     ON contacts (client_id, opt_out_state);
CREATE INDEX contacts_client_hash_idx       ON contacts (client_id, phone_hash);     -- the mirror reconciler's join key
CREATE INDEX contacts_name_trgm_idx         ON contacts USING gin (client_id, display_name gin_trgm_ops);  -- needs btree_gin

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON contacts FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE contacts OWNER TO wp_migrator;

-- wp_app: no DELETE - erasure is a soft-delete UPDATE (deleted_at + PII
-- scrub), never a real DELETE (P20 step 7).
GRANT SELECT, INSERT, UPDATE ON contacts TO wp_app;
GRANT SELECT ON contacts TO wp_admin_app;

-- ---------------------------------------------------------------------
-- 2. contact_tags - tags-as-lists.
-- ---------------------------------------------------------------------
CREATE TABLE contact_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES clients(id), name citext NOT NULL, color text,
  contact_count int NOT NULL DEFAULT 0, created_by_user_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_tags_client_id_name_key UNIQUE (client_id, name));

ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_tags FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON contact_tags FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE contact_tags OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE, DELETE ON contact_tags TO wp_app;
GRANT SELECT ON contact_tags TO wp_admin_app;

-- ---------------------------------------------------------------------
-- 3. contact_tag_links - the tag <-> contact join; PK already leads with
-- client_id, so no CANONICAL_AUTHORITY_KEYS entry is needed.
-- ---------------------------------------------------------------------
CREATE TABLE contact_tag_links (
  client_id uuid NOT NULL REFERENCES clients(id),
  tag_id uuid NOT NULL REFERENCES contact_tags(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, tag_id, contact_id));
CREATE INDEX ctl_by_contact_idx ON contact_tag_links (client_id, contact_id);

ALTER TABLE contact_tag_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_tag_links FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON contact_tag_links FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE contact_tag_links OWNER TO wp_migrator;

GRANT SELECT, INSERT, DELETE ON contact_tag_links TO wp_app;
GRANT SELECT ON contact_tag_links TO wp_admin_app;

-- ---------------------------------------------------------------------
-- 4. contact_imports - the resumable CSV import job.
-- ---------------------------------------------------------------------
CREATE TABLE contact_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES clients(id),
  filename text, storage_key text NOT NULL,             -- built only by storage.put()
  mapping jsonb NOT NULL,                               -- {phone:'col A', name:'col B', attrs:{city:'col C'}}
  default_country char(2) NOT NULL,                     -- from clients.country_code, user-overridable
  apply_tag_ids uuid[] NOT NULL DEFAULT '{}',
  attestation_text text NOT NULL,                       -- the tenant's own words about where the list came from
  attested_by_user_id uuid NOT NULL, attested_at timestamptz NOT NULL,
  status contact_import_status NOT NULL DEFAULT 'uploaded',
  cursor_row bigint NOT NULL DEFAULT 0,                 -- resumable; batches of 500 CSV RECORDS per transaction
  total_rows int, imported_count int NOT NULL DEFAULT 0, updated_count int NOT NULL DEFAULT 0,
  invalid_count int NOT NULL DEFAULT 0, duplicate_count int NOT NULL DEFAULT 0,
  opted_out_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz);
CREATE INDEX contact_imports_client_created_idx ON contact_imports (client_id, created_at DESC);
CREATE INDEX contact_imports_client_status_idx  ON contact_imports (client_id, status);

ALTER TABLE contact_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_imports FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON contact_imports FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE contact_imports OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE ON contact_imports TO wp_app;
GRANT SELECT ON contact_imports TO wp_admin_app;

-- ---------------------------------------------------------------------
-- 5. contact_import_errors - retained rows capped at 1,000 per import; the
-- rest are counted via contact_imports.invalid_count. PK (import_id, row_no)
-- is the ONE canonical suite-A exemption for this table (scope delta) -
-- already present in SUITE_A_INDEX_EXEMPTIONS, not touched by this migration.
-- ---------------------------------------------------------------------
CREATE TABLE contact_import_errors (
  import_id uuid NOT NULL REFERENCES contact_imports(id) ON DELETE CASCADE, client_id uuid NOT NULL REFERENCES clients(id), row_no bigint NOT NULL,
  reason text NOT NULL, raw_excerpt text,               -- excerpt capped at 120 chars, never logged
  CONSTRAINT contact_import_errors_excerpt_max_120 CHECK (raw_excerpt IS NULL OR char_length(raw_excerpt) <= 120),
  PRIMARY KEY (import_id, row_no));
CREATE INDEX cie_client_import_idx ON contact_import_errors (client_id, import_id, row_no);

ALTER TABLE contact_import_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_import_errors FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON contact_import_errors FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE contact_import_errors OWNER TO wp_migrator;

-- DELETE = the 30-day retention purge.
GRANT SELECT, INSERT, DELETE ON contact_import_errors TO wp_app;
GRANT SELECT ON contact_import_errors TO wp_admin_app;

-- ---------------------------------------------------------------------
-- 6. consent_records - append-only consent-basis evidence. Created here
-- because P02 never created it (see header). One row per import-level
-- attestation (recipient_e164 NULL), never one row per contact.
-- ---------------------------------------------------------------------
CREATE TABLE consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  recipient_e164 text,                                  -- NULL for an import-level attestation (one row per import, never per contact)
  basis consent_basis NOT NULL,
  evidence_ref text,                                    -- e.g. 'contact_import:<uuid>'
  source_note text,                                     -- the attesting user's own words (= contact_imports.attestation_text)
  captured_at timestamptz NOT NULL DEFAULT now(),
  captured_by_user_id uuid);
CREATE INDEX consent_records_client_captured_idx ON consent_records (client_id, captured_at DESC);

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consent_records FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE consent_records OWNER TO wp_migrator;

-- append-only: no UPDATE/DELETE for any app role.
GRANT SELECT, INSERT ON consent_records TO wp_app;
GRANT SELECT ON consent_records TO wp_admin_app;
