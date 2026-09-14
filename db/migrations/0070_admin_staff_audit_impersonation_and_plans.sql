-- P28 (admin-internal-api-and-panel) Unit U1 - migration 0070. Builds the
-- internal-API/admin-panel storage surface: staff identity + sessions,
-- time-boxed impersonation grants, the staff-audit idempotency/replay
-- authority, and the plan catalogue's key/description/default fields.
--
-- O2 corrections (do not re-derive): `staff_users`/`staff_sessions` do NOT
-- exist anywhere in this repo before this migration - the phase file's
-- prerequisite claiming otherwise was wrong; this migration CREATEs both.
-- `client_limit_overrides` and `instance_pacing_overrides` already exist
-- (migration 0030) and are only ALTERed here (new actor_staff_id/
-- expiry_applied_at columns), never re-created. `staff_audit_log` already
-- exists (migration 0058) and its own header says P28 must ALTER it, never
-- CREATE it - this migration does exactly that (target_kind, result,
-- backfilled NOT NULL idempotency_key/request_hash, the UNIQUE(idempotency_
-- key) authority).
--
-- CREATE vs ALTER, in order:
--   1. CREATE TYPE staff_role, impersonation_scope.
--   2. CREATE staff_users - staff identity, argon2id password_hash, MFA
--      secret as a sealed envelope (bytea, same "envelope-encrypted, never
--      plaintext" discipline as users.mfa_totp_secret_enc, migration 0013),
--      token_epoch for session invalidation (same Postgres-is-the-authority
--      pattern as users.token_epoch), lockout counters. Non-tenant: staff
--      belong to WP, not to a client.
--   3. CREATE staff_sessions - refresh-token-hash session record, one row
--      per staff login, revocable/rotatable (revoked_at/replaced_by).
--   4. CREATE impersonation_grants - THE audit trail for a staff session
--      acting inside a tenant's workspace. Tenant table (client_id NOT
--      NULL, RLS ENABLE+FORCE, standard tenant_isolation policy - copied
--      verbatim from migration 0058's topup_requests block). Hard ceilings
--      enforced by CHECK, not application code (core invariant 3's
--      "idempotency/invariants at the storage layer" extended to time
--      bounds): a metadata-only grant is capped at 30 minutes, a
--      message-body-access grant ("with_message_bodies") is capped at 15
--      minutes and always chains back to the metadata grant it elevates
--      via parent_grant_id - the storage layer itself makes "start a body
--      grant with no metadata grant open" merely unusual, not impossible;
--      the internal API is the enforcement point for that chain, this
--      schema only bounds duration.
--   5. ALTER staff_audit_log - adds target_kind/result and makes the
--      idempotency/replay authority real: two NULL-backfill UPDATEs (
--      idempotency_key -> 'legacy:'||id for old P19 rows that predate this
--      column being mandatory; request_hash -> '' for the same rows), then
--      SET NOT NULL on both plus the UNIQUE(idempotency_key) constraint the
--      internal API's replay-on-idempotency-key-hit path requires (core
--      invariant 3: unique keys are mandatory at the DB level, never an
--      application-only check). Deliberately NO FK from staff_id to
--      staff_users: pre-existing P19 rows and this migration's own tests
--      carry synthetic staff ids that do not exist in the new table, and
--      the internal API validates the acting staff user at request time
--      instead (a session-bound check, not a storage-level FK) - adding the
--      FK now would make every legacy audit row (and any future staff
--      deletion/rotation) a migration hazard for no isolation benefit (this
--      table is already RLS-scoped and staff-authenticated at the API
--      layer).
--   6. ALTER client_limit_overrides / instance_pacing_overrides - add
--      actor_staff_id (which staff user made a tenant-limit/pacing
--      override) and, for instance_pacing_overrides only,
--      expiry_applied_at (stamped once by the expiry sweep that re-resolves
--      eff_* after an admin_relax override lapses - lets the sweep find
--      "expired but not yet reconciled" rows without a second table).
--   7. GRANT UPDATE (override_items, updated_at) ON client_pricing TO
--      wp_app - staff pricing overrides run inside app/backend's own wp_app
--      transaction (ADR 0014 fact 12: admin/backend never writes tenant
--      data directly, it calls app/backend's internal API), so the WRITER
--      role for this column is wp_app, not wp_admin_app.
--   8. GRANT INSERT ON audit_logs TO wp_admin_app - admin/backend's
--      platformRead() writes its own audit row (an append-only send-path-
--      adjacent but NOT send-path table - see SEND_PATH_TABLES, audit_logs
--      is not on it) in the same transaction as every cross-tenant
--      platform-level read it performs; this is the one legitimate
--      wp_admin_app INSERT grant in the schema (blueprint R-33 forbids
--      wp_admin_app writes only to send-path tables).
--   9. Plan catalogue - plans gains key/description/is_default; plan_limits
--      is unchanged (already has every column this migration's seed rows
--      need). Three deterministic-id plans are seeded (idempotent via
--      ON CONFLICT (id) DO UPDATE, same idiom as db/seeds/*.sql), and every
--      pre-existing client with a NULL plan_id is backfilled onto the new
--      default (`starter`) plan: P26b's finding was that plan-gated
--      admission fails CLOSED with no plan at all, so a workspace with no
--      plan today would be unable to connect a single instance once P26b's
--      admission check ships - the safe fix is to give every such workspace
--      the smallest paid tier's limits now, not to special-case "no plan"
--      as unlimited. Signup assigns the default plan going forward (P28
--      U5, not this migration).
--
-- RLS / grants for the two new non-tenant tables (staff_users,
-- staff_sessions) follow the same "wp_admin_app read/write, wp_app
-- narrow-SELECT-only where it needs to resolve the acting staff user's
-- role for its own server-side RBAC re-check" split this phase's dispatch
-- specifies - see each CREATE TABLE block below for the exact grant.
--
-- Suite-A registration (companion TS change, db/src/isolation/tenant-
-- tables.ts): `impersonation_grants` -> TENANT_TABLE_COVERAGE ('client_id'),
-- surrogate uuid PK -> CANONICAL_AUTHORITY_KEYS entry (precedent
-- topup_requests); `staff_users`/`staff_sessions`/`staff_audit_log` (already
-- registered) -> ISOLATION_NON_TENANT_TABLES.

CREATE TYPE staff_role AS ENUM ('support', 'ops', 'superadmin');
CREATE TYPE impersonation_scope AS ENUM ('metadata_only', 'with_message_bodies');

-- ---------------------------------------------------------------------
-- 1. staff_users - WP staff identity. Non-tenant (no client_id).
-- ---------------------------------------------------------------------
CREATE TABLE staff_users (
  id                    uuid NOT NULL,
  email                 citext NOT NULL,
  full_name             text NOT NULL,
  password_hash         text NOT NULL, -- argon2id
  role                  staff_role NOT NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  mfa_totp_secret_enc   bytea, -- envelope-encrypted, never plaintext (purpose user-secrets)
  mfa_enabled_at        timestamptz,
  token_epoch           bigint NOT NULL DEFAULT 0, -- Postgres is the authority; Redis is only a cache
  failed_login_count    int NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_users_pkey PRIMARY KEY (id),
  CONSTRAINT staff_users_email_key UNIQUE (email)
);

ALTER TABLE staff_users OWNER TO wp_migrator;

-- wp_admin_app: SELECT/INSERT/UPDATE - admin/backend authenticates staff
-- and maintains lockout/MFA/token_epoch. wp_app: narrow SELECT only (id,
-- role, status, full_name) - app/backend resolves the acting staff user's
-- role for its own server-side RBAC re-check on internal-API calls. No
-- DELETE for anyone but wp_migrator.
GRANT SELECT, INSERT, UPDATE ON staff_users TO wp_admin_app;
GRANT SELECT (id, role, status, full_name) ON staff_users TO wp_app;

-- ---------------------------------------------------------------------
-- 2. staff_sessions - one row per staff login/refresh-token session.
-- ---------------------------------------------------------------------
CREATE TABLE staff_sessions (
  id                    uuid NOT NULL,
  staff_id              uuid NOT NULL REFERENCES staff_users(id),
  refresh_token_hash    bytea NOT NULL,
  ip                    inet,
  user_agent_hash       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  revoked_at            timestamptz,
  replaced_by           uuid,
  CONSTRAINT staff_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT staff_sessions_refresh_token_hash_key UNIQUE (refresh_token_hash)
);

CREATE INDEX staff_sessions_staff_created_idx
  ON staff_sessions (staff_id, created_at DESC);

ALTER TABLE staff_sessions OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE ON staff_sessions TO wp_admin_app;

-- ---------------------------------------------------------------------
-- 3. impersonation_grants - time-boxed staff access to a tenant workspace.
--    Tenant table: client_id NOT NULL, RLS ENABLE + FORCE, standard
--    tenant_isolation policy (copied verbatim from migration 0058's
--    topup_requests block).
-- ---------------------------------------------------------------------
CREATE TABLE impersonation_grants (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES clients(id),
  staff_id          uuid NOT NULL REFERENCES staff_users(id),
  target_user_id    uuid, -- the workspace owner the session acts as; nullable
  scope             impersonation_scope NOT NULL DEFAULT 'metadata_only',
  reason            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  revoked_reason    text,
  parent_grant_id   uuid REFERENCES impersonation_grants(id), -- set on a body-elevation grant, pointing at the metadata grant it elevates
  CONSTRAINT impersonation_grants_pkey PRIMARY KEY (id),
  CONSTRAINT impersonation_grants_reason_not_blank CHECK (length(btrim(reason)) > 0),
  CONSTRAINT impersonation_grants_expires_after_created CHECK (expires_at > created_at),
  CONSTRAINT impersonation_grants_max_thirty_minutes
    CHECK (expires_at <= created_at + interval '30 minutes'),
  CONSTRAINT impersonation_grants_body_scope_max_fifteen_minutes
    CHECK (scope <> 'with_message_bodies' OR expires_at <= created_at + interval '15 minutes')
);

-- Leads with client_id (suite A rule) - the tenant-scoped "grants against
-- this workspace, most recent first" read.
CREATE INDEX impersonation_grants_client_expires_idx
  ON impersonation_grants (client_id, expires_at DESC);

ALTER TABLE impersonation_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON impersonation_grants FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE impersonation_grants OWNER TO wp_migrator;

-- wp_app: SELECT/INSERT/UPDATE - app/backend mints and revokes grants
-- inside its own tenant-scoped transaction. wp_admin_app: SELECT only.
GRANT SELECT, INSERT, UPDATE ON impersonation_grants TO wp_app;
GRANT SELECT ON impersonation_grants TO wp_admin_app;

-- ---------------------------------------------------------------------
-- 4. staff_audit_log ALTER (never CREATE - see migration 0058's header).
-- ---------------------------------------------------------------------
ALTER TABLE staff_audit_log ADD COLUMN target_kind text;
-- The first response body as compact JSON text (ids/enums/paise only) -
-- the internal API replays this verbatim on an idempotency-key hit instead
-- of re-executing the mutation.
ALTER TABLE staff_audit_log ADD COLUMN result text NOT NULL DEFAULT '{}';

-- Backfill pre-existing P19 rows before tightening the columns to NOT NULL.
UPDATE staff_audit_log SET idempotency_key = 'legacy:' || id::text WHERE idempotency_key IS NULL;
UPDATE staff_audit_log SET request_hash = '' WHERE request_hash IS NULL;

ALTER TABLE staff_audit_log ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE staff_audit_log ALTER COLUMN request_hash SET NOT NULL;

-- THE idempotency authority for every internal-API mutation (core invariant
-- 3): non-partitioned, so Postgres rejects a duplicate idempotency key with
-- 23505 directly, never an application pre-check. Deliberately no FK from
-- staff_id to staff_users - see this migration's header.
ALTER TABLE staff_audit_log
  ADD CONSTRAINT staff_audit_log_idempotency_key_key UNIQUE (idempotency_key);

-- The internal API inserts the audit row FIRST (the idempotency authority
-- above, result = '{}'), runs the mutation, then writes the response
-- snapshot into that same row's `result` column inside the same
-- transaction - the replay path on an idempotency-key hit reads this back
-- verbatim instead of re-executing the mutation. Every other column stays
-- append-only: no other UPDATE grant, no DELETE, for anyone but wp_migrator.
GRANT UPDATE (result) ON staff_audit_log TO wp_app;

-- ---------------------------------------------------------------------
-- 5. client_limit_overrides / instance_pacing_overrides ALTERs.
-- ---------------------------------------------------------------------
ALTER TABLE client_limit_overrides ADD COLUMN actor_staff_id uuid;

ALTER TABLE instance_pacing_overrides ADD COLUMN actor_staff_id uuid;
ALTER TABLE instance_pacing_overrides ADD COLUMN expiry_applied_at timestamptz;

-- ---------------------------------------------------------------------
-- 6. client_pricing - staff pricing overrides run inside wp_app's own
--    tenant transaction (ADR 0014 fact 12), so wp_app is the writer role.
-- ---------------------------------------------------------------------
GRANT UPDATE (override_items, updated_at) ON client_pricing TO wp_app;

-- ---------------------------------------------------------------------
-- 7. audit_logs - admin/backend's platformRead() writes its own audit row
--    in the same transaction as the cross-tenant read it performs. This is
--    an append-only audit table, not a send-path table (SEND_PATH_TABLES).
-- ---------------------------------------------------------------------
GRANT INSERT ON audit_logs TO wp_admin_app;

-- ---------------------------------------------------------------------
-- 8. Plan catalogue - key/description/is_default, seeded plans, and the
--    NULL-plan_id backfill.
-- ---------------------------------------------------------------------
ALTER TABLE plans ADD COLUMN key text;
ALTER TABLE plans ADD COLUMN description text;
ALTER TABLE plans ADD COLUMN is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX plans_key_uq ON plans (key) WHERE key IS NOT NULL;
CREATE UNIQUE INDEX plans_one_default_uq ON plans ((true)) WHERE is_default;

INSERT INTO plans (id, key, name, is_default)
VALUES ('10000000-0000-4000-8000-000000000001', 'starter', 'Starter', true)
ON CONFLICT (id) DO UPDATE SET key = EXCLUDED.key, name = EXCLUDED.name, is_default = EXCLUDED.is_default;

INSERT INTO plans (id, key, name, is_default)
VALUES ('10000000-0000-4000-8000-000000000002', 'growth', 'Growth', false)
ON CONFLICT (id) DO UPDATE SET key = EXCLUDED.key, name = EXCLUDED.name, is_default = EXCLUDED.is_default;

INSERT INTO plans (id, key, name, is_default)
VALUES ('10000000-0000-4000-8000-000000000003', 'business', 'Business', false)
ON CONFLICT (id) DO UPDATE SET key = EXCLUDED.key, name = EXCLUDED.name, is_default = EXCLUDED.is_default;

INSERT INTO plan_limits
  (plan_id, max_connected_instances, max_registered_instances, max_broadcast_recipients, max_contacts)
VALUES ('10000000-0000-4000-8000-000000000001', 1, 3, 2000, 5000)
ON CONFLICT (plan_id) DO UPDATE SET
  max_connected_instances = EXCLUDED.max_connected_instances,
  max_registered_instances = EXCLUDED.max_registered_instances,
  max_broadcast_recipients = EXCLUDED.max_broadcast_recipients,
  max_contacts = EXCLUDED.max_contacts;

INSERT INTO plan_limits
  (plan_id, max_connected_instances, max_registered_instances, max_broadcast_recipients, max_contacts)
VALUES ('10000000-0000-4000-8000-000000000002', 3, 9, 20000, 50000)
ON CONFLICT (plan_id) DO UPDATE SET
  max_connected_instances = EXCLUDED.max_connected_instances,
  max_registered_instances = EXCLUDED.max_registered_instances,
  max_broadcast_recipients = EXCLUDED.max_broadcast_recipients,
  max_contacts = EXCLUDED.max_contacts;

INSERT INTO plan_limits
  (plan_id, max_connected_instances, max_registered_instances, max_broadcast_recipients, max_contacts)
VALUES ('10000000-0000-4000-8000-000000000003', 10, 30, 100000, 500000)
ON CONFLICT (plan_id) DO UPDATE SET
  max_connected_instances = EXCLUDED.max_connected_instances,
  max_registered_instances = EXCLUDED.max_registered_instances,
  max_broadcast_recipients = EXCLUDED.max_broadcast_recipients,
  max_contacts = EXCLUDED.max_contacts;

-- Every plan-gated admission fails CLOSED without a plan (P26b finding b) -
-- existing workspaces with no plan get the default plan now; signup assigns
-- it from now on (P28 U5, not this migration).
UPDATE clients SET plan_id = '10000000-0000-4000-8000-000000000001'
  WHERE plan_id IS NULL AND deleted_at IS NULL;

-- wp_admin_app already has SELECT on plans/plan_limits (migration 0002);
-- wp_app already has SELECT. No new grant needed here - admin never writes
-- clients.plan_id directly; plan changes go through app/backend's
-- /internal/v1 API as wp_app, which already has UPDATE on clients.
