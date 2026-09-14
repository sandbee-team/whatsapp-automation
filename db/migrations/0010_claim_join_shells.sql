-- P03 (db-queue-and-claim) - migration 0010.
-- The claim's join shells, DDL ONLY - logic is owned by later phases, which
-- must ALTER these tables, never CREATE them:
--   P06 owns `instance_lease_state` logic (fence bumping, lease sweeping).
--   P08 owns `whatsapp_instances` logic (connection/link/health-state
--     transitions, pairing, pause/resume).
--   P23 owns `campaigns` logic (broadcast lifecycle, snapshotting).
-- Creating only what P02 did not already create (clients/users/memberships/
-- wallet_accounts etc. already exist).

-- ---------------------------------------------------------------------
-- whatsapp_instances - final v1 shape, EXCLUDING `current_fence`/
-- `lease_seen_at` (live in instance_lease_state below) and `health_score`
-- (lives in instance_pacing_state, P13). `health_state` (WP policy's
-- verdict) is deliberately never collapsed with `connection_status` (what
-- the Baileys transport reports) - core invariant 2 depends on that
-- separation staying real at the schema level, not just in application code.
-- ---------------------------------------------------------------------
CREATE TABLE whatsapp_instances (
  id                         uuid PRIMARY KEY, -- app-generated uuidv7, no DB default (matches migration 0002's id convention)
  client_id                  uuid NOT NULL REFERENCES clients(id),
  label                      text,
  phone_e164                 text,
  owner_jid                  text,
  provider_kind               text,
  connection_status           text, -- raw, as reported by the Baileys transport - never conflated with health_state
  health_state                wa_health NOT NULL DEFAULT 'never_linked', -- WP policy's verdict, not the raw transport status
  link_state                  wa_link_state DEFAULT 'unlinked',
  desired_state                text NOT NULL DEFAULT 'offline',
  session_epoch                int NOT NULL DEFAULT 0,
  owner_worker_id              text,
  needs_user_action            boolean NOT NULL DEFAULT false,
  user_action_reason           text,
  qr_attempts                  int NOT NULL DEFAULT 0,
  pairing_started_at           timestamptz,
  pause_reason                pause_reason,
  paused_at                    timestamptz,
  paused_by_user_id            uuid,
  disconnection_reason_code    text,
  disconnection_reason_label   text,
  disconnection_reason_at      timestamptz,
  last_connected_at            timestamptz,
  last_success_send_at         timestamptz,
  last_error_class             text,
  capture_groups               boolean NOT NULL DEFAULT false,
  capture_media                boolean NOT NULL DEFAULT false,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  deleted_at                   timestamptz,
  CONSTRAINT wi_desired_state_values CHECK (desired_state IN ('online', 'offline'))
) WITH (fillfactor = 80);

-- The natural "list this client's instances" lookup, and the table's only
-- client_id-leading index (its PK is the surrogate `id`).
CREATE INDEX whatsapp_instances_client_idx
  ON whatsapp_instances (client_id, created_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE whatsapp_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_instances FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE whatsapp_instances OWNER TO wp_migrator;

-- wp_scheduler needs only the claim-join columns named in the P03 dispatch:
-- id, client_id, health_state, session_epoch, deleted_at. No wp_app grant
-- here - P08 (which owns this table's logic) adds whatever the connect/
-- pair/pause endpoints need when it lands.
GRANT SELECT (id, client_id, health_state, session_epoch, deleted_at)
  ON whatsapp_instances TO wp_scheduler;
GRANT SELECT ON whatsapp_instances TO wp_admin_app;

-- ---------------------------------------------------------------------
-- instance_lease_state - NARROW shell; P06 owns fence-bumping/lease-sweep
-- logic and ALTERs this table, never re-CREATEs it.
-- ---------------------------------------------------------------------
CREATE TABLE instance_lease_state (
  instance_id       uuid PRIMARY KEY REFERENCES whatsapp_instances(id),
  client_id         uuid NOT NULL,
  current_fence     bigint NOT NULL DEFAULT 0,
  owner_worker_id    text,
  lease_seen_at      timestamptz
);

-- The table's only client_id-leading index (its PK is instance_id).
CREATE INDEX instance_lease_state_client_idx ON instance_lease_state (client_id);

ALTER TABLE instance_lease_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_lease_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON instance_lease_state FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE instance_lease_state OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE ON instance_lease_state TO wp_scheduler;
GRANT SELECT ON instance_lease_state TO wp_admin_app;

-- ---------------------------------------------------------------------
-- campaigns - NARROW shell; P23 owns broadcast lifecycle logic and ALTERs
-- this table, never re-CREATEs it.
-- ---------------------------------------------------------------------
CREATE TABLE campaigns (
  id           uuid PRIMARY KEY,
  client_id     uuid NOT NULL REFERENCES clients(id),
  status        broadcast_status NOT NULL DEFAULT 'draft',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The natural "list this client's campaigns" lookup, and the table's only
-- client_id-leading index (its PK is the surrogate `id`).
CREATE INDEX campaigns_client_idx ON campaigns (client_id, created_at DESC);

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaigns FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE campaigns OWNER TO wp_migrator;

GRANT SELECT ON campaigns TO wp_scheduler;
GRANT SELECT ON campaigns TO wp_admin_app;
