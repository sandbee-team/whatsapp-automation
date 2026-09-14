-- P04a (auth-signup-and-onboarding) - migration 0013.
-- Additive, forward-only. Four groups:
--   1. ALTER users - password/MFA/session-epoch/lockout columns.
--   2. ALTER clients - consent attestation + pacing-profile acceptance.
--   3. CREATE auth_sessions, email_verification_tokens, password_reset_tokens
--      - user-keyed, NO client_id (same identity-is-global class as `users`
--      itself - migration 0005's comment: "NON-tenant tables ... users ...
--      intentionally get no RLS here"). No table-level grants are widened
--      for `users`/`clients` above: both already carry table-level
--      SELECT/INSERT/UPDATE for wp_app (migration 0005), which automatically
--      covers every newly ADDed column.
--   4. CREATE audit_logs - monthly-partitioned, append-only, client_id
--      NULLABLE by design (NULL = platform-level action).
--
-- Suite-A registration decision (audit_logs): registered in
-- `ISOLATION_NON_TENANT_TABLES`, NOT `TENANT_TABLE_COVERAGE`. Every
-- `TENANT_TABLE_COVERAGE` table in this schema carries client_id NOT NULL
-- (core invariant 4 / database.md: "every business table carries client_id");
-- audit_logs is the one deliberate exception (a platform-level action - staff
-- login, cross-tenant admin action - has no owning tenant at all), so forcing
-- it into the NOT-NULL-shaped tenant registry would be a false claim about
-- its own column, not a real fix. It still gets RLS: ENABLE + FORCE + the
-- standard `tenant_isolation` policy below, scoping a tenant-context read to
-- exactly its own client_id rows - `NULL = <any client_id>` is never true, so
-- a platform-level row is correctly invisible under every tenant context and
-- visible only to a BYPASSRLS role (wp_admin_app). One consequence worth
-- flagging: the same reasoning makes `WITH CHECK` reject an app.client_id-set
-- session inserting a NULL-client_id row - a platform-level audit row must be
-- written by a BYPASSRLS-capable path (wp_admin_app / a system connection
-- with no tenant context), never by wp_app mid-request with a tenant context
-- set. That is the intended shape (a tenant-scoped request should never be
-- able to author a platform-level audit entry), not a bug.

-- ---------------------------------------------------------------------
-- 1. users - auth/session/lockout columns (v1 design doc S1.2).
-- ---------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN password_hash text, -- argon2id; NULL allowed (passkey-only future)
  ADD COLUMN password_updated_at timestamptz,
  ADD COLUMN mfa_totp_secret_enc bytea, -- envelope-encrypted, never plaintext
  ADD COLUMN mfa_enabled_at timestamptz,
  ADD COLUMN failed_login_count int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN last_login_at timestamptz,
  ADD COLUMN token_epoch int NOT NULL DEFAULT 0; -- Postgres is the authority; Redis is only a cache

-- ---------------------------------------------------------------------
-- 2. clients - consent attestation + pacing-profile acceptance.
-- ---------------------------------------------------------------------
ALTER TABLE clients
  ADD COLUMN consent_attested_at timestamptz,
  ADD COLUMN consent_attested_by_user_id uuid REFERENCES users(id),
  ADD COLUMN pacing_profile_key text, -- NO FK: pacing_profiles does not exist until P13
  ADD COLUMN pacing_profile_accepted_at timestamptz;

-- ---------------------------------------------------------------------
-- 3a. auth_sessions - refresh-token rotation chain.
-- ---------------------------------------------------------------------
CREATE TABLE auth_sessions (
  id                  uuid PRIMARY KEY, -- app-generated uuidv7, no DB default (migration 0002 convention)
  user_id             uuid NOT NULL REFERENCES users(id),
  refresh_token_hash  bytea NOT NULL UNIQUE,
  parent_session_id   uuid REFERENCES auth_sessions(id), -- rotation chain, for reuse detection
  issued_at           timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  last_seen_at        timestamptz,
  revoked_at          timestamptz,
  revoked_reason      text,
  ip                  inet,
  user_agent_hash     bytea, -- hash, never the raw UA
  device_label        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_sessions_user_revoked_idx ON auth_sessions (user_id, revoked_at);
CREATE INDEX auth_sessions_expires_idx ON auth_sessions (expires_at);

ALTER TABLE auth_sessions OWNER TO wp_migrator;
GRANT SELECT, INSERT, UPDATE ON auth_sessions TO wp_app;
GRANT SELECT ON auth_sessions TO wp_admin_app;

-- ---------------------------------------------------------------------
-- 3b/3c. email_verification_tokens / password_reset_tokens - identical
-- shape. Rows are immutable after consumption: `consumed_at` is the only
-- field ever written after INSERT, and only once - hence no `updated_at`.
-- ---------------------------------------------------------------------
CREATE TABLE email_verification_tokens (
  id           uuid PRIMARY KEY, -- app-generated uuidv7, no DB default
  user_id      uuid NOT NULL REFERENCES users(id),
  token_hash   bytea NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_verification_tokens_user_idx ON email_verification_tokens (user_id);

ALTER TABLE email_verification_tokens OWNER TO wp_migrator;
GRANT SELECT, INSERT, UPDATE ON email_verification_tokens TO wp_app;
GRANT SELECT ON email_verification_tokens TO wp_admin_app;

CREATE TABLE password_reset_tokens (
  id           uuid PRIMARY KEY, -- app-generated uuidv7, no DB default
  user_id      uuid NOT NULL REFERENCES users(id),
  token_hash   bytea NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);

ALTER TABLE password_reset_tokens OWNER TO wp_migrator;
GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO wp_app;
GRANT SELECT ON password_reset_tokens TO wp_admin_app;

-- ---------------------------------------------------------------------
-- 4. audit_logs - MONTHLY-partitioned by created_at, append-only. See the
-- header comment above for the suite-A registration decision. No storage
-- parameter on the partitioned PARENT (PG17 rejects it - migration 0007's
-- same finding).
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id                        bigint GENERATED ALWAYS AS IDENTITY,
  client_id                 uuid, -- NULL = platform-level action - deliberate, see header comment
  actor_type                text NOT NULL,
  actor_user_id             uuid,
  actor_staff_id            uuid,
  actor_api_key_id          uuid,
  impersonated_by_staff_id  uuid,
  action                    text NOT NULL, -- dotted, e.g. 'auth.signup', 'auth.lockout', 'instance.pause'
  target_type               text,
  target_id                 text,
  metadata                  jsonb, -- allow-listed keys only, enforced app-side
  ip                        inet,
  request_id                text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_pkey PRIMARY KEY (id, created_at),
  CONSTRAINT audit_logs_actor_type_check CHECK (actor_type IN ('user', 'api_key', 'staff', 'system'))
) PARTITION BY RANGE (created_at);

-- Current + next 2 months, via the step-5 helper (migration 0003) - also
-- unconditionally seals each partition with its own RLS ENABLE+FORCE+policy.
SELECT public.wp_ensure_month_partition('audit_logs'::regclass, (now())::date);
SELECT public.wp_ensure_month_partition('audit_logs'::regclass, (now() + interval '1 month')::date);
SELECT public.wp_ensure_month_partition('audit_logs'::regclass, (now() + interval '2 months')::date);

CREATE INDEX audit_logs_client_created_idx ON audit_logs (client_id, created_at DESC);
CREATE INDEX audit_logs_action_created_idx ON audit_logs (action, created_at DESC);
CREATE INDEX audit_logs_staff_created_idx
  ON audit_logs (actor_staff_id, created_at DESC)
  WHERE actor_staff_id IS NOT NULL;

-- RLS on the PARENT (each partition already carries its own copy, sealed by
-- wp_ensure_month_partition above) - same standard predicate as every other
-- tenant_isolation policy; see the header comment for the NULL-client_id
-- consequence.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_logs FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE audit_logs OWNER TO wp_migrator;

DO $$
DECLARE
  v_schema name;
  v_table  name;
BEGIN
  FOR v_schema, v_table IN
    SELECT n.nspname, c.relname
      FROM pg_catalog.pg_inherits i
      JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE i.inhparent = 'public.audit_logs'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO wp_migrator', v_schema, v_table);
  END LOOP;
END;
$$;

-- Append-only at the grant level (core invariant 3): wp_app can INSERT and
-- SELECT but never UPDATE/DELETE a row, at the database level - mirrors
-- wallet_ledger's append-only grant shape (migration 0005).
GRANT SELECT, INSERT ON audit_logs TO wp_app;
GRANT SELECT ON audit_logs TO wp_admin_app;
