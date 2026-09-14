-- Go-live session, Unit U1 - migration 0076. Creates `api_keys` so a tenant
-- can authenticate an HTTP API call with a key instead of a logged-in
-- session (auth/route/panel units are separate and consume this table's
-- shape as their contract; this migration is schema-only).
--
-- `key_prefix` is GLOBALLY unique (`api_keys_key_prefix_uq`), not scoped by
-- client_id like every other unique authority in this schema: a presenter
-- (an inbound HTTP request) supplies only the raw key string, with no tenant
-- context at all - the prefix is the pre-hash LOOKUP HANDLE the auth path
-- uses to find the one candidate row before it ever computes an HMAC, so it
-- must be findable with no `client_id` in hand. That is also why the lookup
-- needs `wp_api_key_lookup` below: under FORCE RLS a plain `wp_app` SELECT
-- with no `app.client_id` GUC set returns zero rows for every table this
-- migration protects, `api_keys` included.
--
-- The secret itself is hashed with HMAC-SHA256 + a pepper (`api-key-pepper`,
-- added to KEK_PURPOSES below), never bcrypt/argon2: the presented secret is
-- 256 bits of CSPRNG output, not a human-chosen password, so it already has
-- full entropy - a slow KDF's whole purpose is to make a low-entropy secret
-- expensive to brute-force, which buys nothing here and only taxes every hot
-- auth-path request. The pepper (KEK-managed, never stored in this table or
-- this database) is what defeats a DB-only offline attack: a stolen
-- `secret_hash` column is unusable without the pepper, which lives outside
-- Postgres entirely - same threat model `opt_outs.phone_hash` /
-- `message_jobs.recipient_hash` already use the `optout-pepper` KEK purpose
-- for (migration 0036), except HMAC output here is compared, not looked up
-- by hash.
--
-- No `scopes` column in v1: exactly one route accepts an API key (the
-- contract this migration exists for). An unenforced scopes column would
-- invite false granularity - a caller could set it, believe it constrains
-- something, and be wrong, because nothing reads it yet. Widening to real
-- per-key scopes later is additive (a new nullable/defaulted column plus
-- enforcement code), so omitting it now costs nothing forward-compatible.
--
-- Shape/registry notes (same conventions verified against migration 0066's
-- wa_groups, the most recent tenant-table precedent):
--   - `id` is `uuid DEFAULT gen_random_uuid()` - server-minted at insert,
--     like `wa_groups.id`/`contact_imports.id`, not client-supplied.
--   - PK `(client_id, id)` already leads with client_id, so `api_keys` needs
--     no CANONICAL_AUTHORITY_KEYS entry (verified against that registry's own
--     rule: an entry is only needed when a PK or unique index does NOT lead
--     with the tenant key - here it does).
--   - `api_keys_key_prefix_uq` is registered in GLOBAL_UNIQUE_INDEXES with a
--     one-line reason (the same registry `clients_slug_key` uses for a
--     non-tenant-scoped uniqueness authority), NOT in
--     SUITE_A_INDEX_EXEMPTIONS (that list is closed at exactly three
--     pre-existing entries, pinned by its own test).
--   - `api_keys_client_created_idx` is the panel's per-tenant key-list query
--     (`client_id, created_at DESC`), same shape as every other tenant
--     listing index in this schema.
--
-- RLS + grants: ENABLE + FORCE + the standard `tenant_isolation` policy
-- (migration 0066's exact shape). Grants:
--   - wp_app: SELECT (the panel lists a tenant's own keys), INSERT (issuing a
--     new key), and column-scoped UPDATE on exactly `(revoked_at,
--     last_used_at)` - revocation and last-used-stamping are the only writes
--     the API path ever performs after creation; every other column
--     (name/key_prefix/secret_hash/last4/created_by_user_id) is immutable
--     after insert, same column-scoped-UPDATE idiom as migration 0068's
--     `GRANT UPDATE (groups_sync_requested_at)`.
--   - wp_admin_app: SELECT only (staff/ops visibility), same as every other
--     tenant table's admin-app grant.
--   - NO DELETE grant to any role: a key is revoked (`revoked_at`), never
--     deleted, same "no DELETE grant to any role" rule as
--     campaign_recipients/leads/wa_groups.
--
-- `wp_api_key_lookup(p_key_prefix text)`: a SECURITY DEFINER helper, same
-- ownership/hardening convention as migration 0015's
-- `wp_client_id_for_user` (owned by `wp_admin_app`, the one BYPASSRLS role,
-- with a pinned `search_path` so it cannot be tricked by a search_path
-- injection - migration 0006's hardening rule). It exists because a request
-- presenting a key has no tenant context: under FORCE RLS a plain `wp_app`
-- SELECT against `api_keys` with no `app.client_id` GUC set returns zero
-- rows for every prefix, indistinguishable from "no such key" - every API
-- request would 401 looking exactly like a hashing/pepper bug, not a
-- authorization-model bug. Returns AT MOST ONE row (key_prefix is globally
-- unique) and deliberately does NOT filter out revoked keys: the caller
-- (application code) decides what to do with a revoked key, so a revoked key
-- is rejected EXPLICITLY with its own error/audit path, rather than being
-- silently indistinguishable from a wrong/unknown key at the SQL layer.

CREATE TABLE api_keys (
  client_id              uuid NOT NULL REFERENCES clients(id),
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  name                   text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  key_prefix             text NOT NULL CHECK (key_prefix ~ '^wp_live_[0-9a-f]{12}$'),
  secret_hash            bytea NOT NULL,
  last4                  text NOT NULL CHECK (last4 ~ '^[0-9a-f]{4}$'),
  created_by_user_id     uuid NOT NULL REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_used_at           timestamptz,
  revoked_at             timestamptz,
  PRIMARY KEY (client_id, id)
);

CREATE UNIQUE INDEX api_keys_key_prefix_uq ON api_keys (key_prefix);
CREATE INDEX api_keys_client_created_idx ON api_keys (client_id, created_at DESC);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON api_keys FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE api_keys OWNER TO wp_migrator;

GRANT SELECT, INSERT ON api_keys TO wp_app;
GRANT UPDATE (revoked_at, last_used_at) ON api_keys TO wp_app;
GRANT SELECT ON api_keys TO wp_admin_app;

CREATE OR REPLACE FUNCTION public.wp_api_key_lookup(p_key_prefix text)
RETURNS TABLE (
  client_id uuid,
  id uuid,
  secret_hash bytea,
  created_by_user_id uuid,
  revoked_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT client_id, id, secret_hash, created_by_user_id, revoked_at
    FROM public.api_keys
   WHERE key_prefix = p_key_prefix
$$;

ALTER FUNCTION public.wp_api_key_lookup(text) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_api_key_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_api_key_lookup(text) TO wp_app;
