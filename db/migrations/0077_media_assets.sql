-- P34 U-upload (ADR 0052 "Founder acceptance 2026-09-14 - ACCEPTED SCOPE")
-- migration 0077. Creates `media_assets`: one row per uploaded outbound
-- media object, tenant-scoped, referenced from a message job's payload by
-- `mediaId` (never by raw storage key or bytes - the job payload NEVER
-- carries the storage key, only the id).
--
-- ACCEPTED SCOPE ONLY (this file, not the ADR body): `kind` is restricted to
-- `'image'`/`'document'` by a CHECK, not the ADR body's five-kind design -
-- video/audio/location/contact_card are DESIGNED, NOT APPROVED and must not
-- be accepted here without a follow-up migration.
--
-- Shape notes:
--   - `client_id uuid NOT NULL` LEADS the PK `(client_id, id)` - the
--     standard tenant-table shape (`database.md`: "every business table
--     carries client_id"), so no CANONICAL_AUTHORITY_KEYS entry is needed
--     (the PK already leads with client_id).
--   - `id` is `uuid DEFAULT gen_random_uuid()` - server-minted at insert
--     (the upload route never accepts a client-supplied id), same
--     convention as `contact_imports.id`/`wa_groups.id`.
--   - `sha256 bytea NOT NULL` plus the UNIQUE `(client_id, sha256)` index is
--     THE dedupe authority (ADR 0052 accepted item 2): the same bytes
--     uploaded twice by one tenant resolve to ONE asset row - the upload
--     service does an INSERT ... ON CONFLICT (client_id, sha256) DO NOTHING
--     then re-SELECTs, never a blind INSERT.
--   - `file_name text` is NULLABLE: an `image` upload need not carry one (no
--     kind CHECK requires it in the accepted image+document slice; a
--     document's `fileName` is supplied by the caller and stored here so the
--     wire response can echo it without a second read).
--   - `created_by_user_id uuid NULL` - an API-key principal (session_or_
--     api_key policy on POST /v1/media, go-live U3's `verifyApiKey` path)
--     has no `users` row to attribute the upload to; NULL means "uploaded
--     by an API key, not a human session" and is never backfilled.
--   - `last_used_at timestamptz` starts NULL (never used at upload time);
--     the send half (a sibling P34 unit) stamps it at every dispatch that
--     references the asset, through the column-scoped `wp_scheduler` grant
--     below. The retention sweep (this unit) reads
--     `COALESCE(last_used_at, created_at)` as its age clock.
--
-- RLS + grants: ENABLE + FORCE + the standard `tenant_isolation` policy
-- (migration 0066's exact shape).
--   - wp_app: SELECT (the panel/API reads asset metadata back), INSERT (the
--     upload route), and column-scoped UPDATE (last_used_at) - ADR 0052
--     accepted item 2 ("upload-then-send") never lets the API relabel a
--     stored asset's kind/mime/size/file_name/sha256/storage_key after
--     insert, so those columns get no UPDATE grant to any role.
--   - wp_scheduler: SELECT (the send worker resolves mediaId -> storage key
--     at dispatch) and the SAME column-scoped UPDATE (last_used_at) - the
--     dispatch path stamps the clock the retention sweep reads, same
--     column-scoped-UPDATE idiom as migration 0068's
--     `GRANT UPDATE (groups_sync_requested_at)`.
--   - wp_admin_app: SELECT only (staff/ops visibility), same as every other
--     tenant table's admin-app grant.
--   - NO DELETE grant to any role: the retention sweep (app code, this
--     unit's `modules/media/retention-purge.ts`) runs as `wp_app` under
--     `tenantDb.withTenant`, so `wp_app` DOES need DELETE, unlike
--     `api_keys`'/`wa_groups`' "revoked/left, never deleted" shape - an
--     asset's row IS hard-deleted 90 days after last use (ADR 0052 accepted
--     item 7). This is the one column/row-shape difference from those two
--     precedents, called out explicitly rather than copied blindly.

CREATE TABLE media_assets (
  client_id              uuid NOT NULL REFERENCES clients(id),
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  kind                   text NOT NULL CHECK (kind IN ('image', 'document')),
  mime_type              text NOT NULL,
  size_bytes             bigint NOT NULL CHECK (size_bytes > 0),
  file_name              text,
  storage_key            text NOT NULL,
  sha256                 bytea NOT NULL,
  created_by_user_id     uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_used_at           timestamptz,
  PRIMARY KEY (client_id, id)
);

CREATE UNIQUE INDEX media_assets_client_sha256_uq ON media_assets (client_id, sha256);
CREATE INDEX media_assets_retention_idx ON media_assets (client_id, last_used_at, created_at);

ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON media_assets FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE media_assets OWNER TO wp_migrator;

GRANT SELECT, INSERT, DELETE ON media_assets TO wp_app;
GRANT UPDATE (last_used_at) ON media_assets TO wp_app;
GRANT SELECT ON media_assets TO wp_scheduler;
GRANT UPDATE (last_used_at) ON media_assets TO wp_scheduler;
GRANT SELECT ON media_assets TO wp_admin_app;
