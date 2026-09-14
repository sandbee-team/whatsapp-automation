-- P07 (session-auth-store) Unit U2 - migration 0020.
-- The two durable session tables: `whatsapp_session_credentials` (one row
-- per instance, the full serialized Baileys creds) and
-- `whatsapp_session_keys` (one row per (instance, key_type, key_id) durable
-- Signal key - only the three DURABLE_KEY_TYPES from `@wp/domain`
-- (pre-key/app-state-sync-key/app-state-sync-version); the remaining seven
-- Baileys auth-key types live in Redis, never here - see
-- packages/domain/src/session/auth-key-types.ts).
--
-- Both tables carry the same envelope-encryption column set: the payload is
-- AES-GCM sealed (`ciphertext`/`iv`/`auth_tag`) under a per-row data
-- encryption key that is itself wrapped by a KEK (`dek_wrapped`/`dek_iv`/
-- `dek_tag`/`kek_id`), versioned so a future crypto-scheme change is
-- forward-compatible (`enc_version`). Neither table has ever existed before
-- (a pure CREATE, no prior shell to ALTER).

-- ---------------------------------------------------------------------
-- whatsapp_session_credentials - one row per instance, the full serialized
-- Baileys `AuthenticationCreds` blob. `cred_version` is a per-row optimistic
-- version counter for the credential-write path; `owner_fence` is the
-- instance_lease_state fence value the writer held when it wrote this row
-- (same fence-protocol class as message_jobs.owner_fence, ADR 0029) - a
-- stale/superseded worker's write is rejected by a conditional UPDATE
-- (`WHERE owner_fence = <held fence>`), never a blind write (core invariant
-- 3). `rotated_at` records the last full re-pairing/credential-rotation
-- event, distinct from `updated_at`'s every-write bump.
--
-- FILLFACTOR 80 only, no autovacuum tuning: unlike whatsapp_session_keys
-- below, this table is not written on every message-send tick - Baileys only
-- rewrites the full creds blob on session-affecting events (pairing,
-- rotation, periodic creds.update), a much lower churn rate than the
-- per-key-use pattern the keys table sees.
-- ---------------------------------------------------------------------
CREATE TABLE whatsapp_session_credentials (
  instance_id   uuid PRIMARY KEY REFERENCES whatsapp_instances(id),
  client_id     uuid NOT NULL REFERENCES clients(id),
  ciphertext    bytea NOT NULL,
  iv            bytea NOT NULL,
  auth_tag      bytea NOT NULL,
  dek_wrapped   bytea NOT NULL,
  dek_iv        bytea NOT NULL,
  dek_tag       bytea NOT NULL,
  kek_id        text NOT NULL,
  enc_version   int NOT NULL,
  session_epoch int NOT NULL DEFAULT 0,
  cred_version  bigint NOT NULL,
  owner_fence   bigint NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  rotated_at    timestamptz
) WITH (fillfactor = 80);

-- The table's only client_id-leading index (its PK is instance_id) - the
-- same shape as instance_lease_state_client_idx (migration 0010).
CREATE INDEX whatsapp_session_credentials_client_idx
  ON whatsapp_session_credentials (client_id);

ALTER TABLE whatsapp_session_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_session_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_session_credentials FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE whatsapp_session_credentials OWNER TO wp_migrator;

-- wp_app only. wp_scheduler gets nothing - the dispatch-loop role never
-- touches session ciphertext. wp_admin_app DELIBERATELY gets nothing either
-- (unlike whatsapp_instances, which grants wp_admin_app SELECT): staff must
-- never be able to read session credential ciphertext - a read grant here
-- would be a data-exposure surface with no legitimate staff use case, and a
-- write grant would be a session-takeover primitive, same forbidden class as
-- the instance_lease_state/whatsapp_instances write bans (ADR 0029).
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_session_credentials TO wp_app;

-- ---------------------------------------------------------------------
-- whatsapp_session_keys - one row per (instance, key_type, key_id) durable
-- Signal key. `key_type` is CHECK-constrained to the three DURABLE_KEY_TYPES
-- (pre-key/app-state-sync-key/app-state-sync-version); the CHECK enum list
-- is asserted at runtime against `@wp/domain`'s `DURABLE_KEY_TYPES` (test:
-- session_key_type_check_matches_domain_durable_types) so the two can never
-- silently drift.
--
-- FILLFACTOR 70 + aggressive autovacuum: this table sees per-key-use churn
-- (a pre-key is consumed and replaced on prekey exchange; app-state-sync
-- keys/versions rotate on every app-state mutation) - same "renew-hot,
-- narrow" reasoning as instance_lease_state's storage-parameter tuning
-- (migration 0018), just applied to a table with many more rows (per key,
-- not per instance).
-- ---------------------------------------------------------------------
CREATE TABLE whatsapp_session_keys (
  instance_id   uuid NOT NULL REFERENCES whatsapp_instances(id),
  client_id     uuid NOT NULL REFERENCES clients(id),
  key_type      text NOT NULL,
  key_id        text NOT NULL,
  ciphertext    bytea NOT NULL,
  iv            bytea NOT NULL,
  auth_tag      bytea NOT NULL,
  dek_wrapped   bytea NOT NULL,
  dek_iv        bytea NOT NULL,
  dek_tag       bytea NOT NULL,
  kek_id        text NOT NULL,
  enc_version   int NOT NULL,
  owner_fence   bigint NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, key_type, key_id),
  CONSTRAINT wsk_key_type_check
    CHECK (key_type IN ('pre-key', 'app-state-sync-key', 'app-state-sync-version'))
) WITH (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_cost_limit = 2000);

-- The table's only client_id-leading index (its PK leads with instance_id).
CREATE INDEX whatsapp_session_keys_client_idx
  ON whatsapp_session_keys (client_id);

ALTER TABLE whatsapp_session_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_session_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_session_keys FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE whatsapp_session_keys OWNER TO wp_migrator;

-- wp_app only - same deliberate omissions as whatsapp_session_credentials
-- above (wp_scheduler: never touches session ciphertext; wp_admin_app:
-- staff must never read/write session key ciphertext).
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_session_keys TO wp_app;
