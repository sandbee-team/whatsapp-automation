-- P04a (auth-signup-and-onboarding) Unit UA5b - migration 0014.
-- CREATE mfa_recovery_codes: one-time-use TOTP MFA recovery codes.
-- User-keyed, NO client_id - same identity-is-global class as
-- auth_sessions/email_verification_tokens/password_reset_tokens (migration
-- 0013's header comment: "identity is global, the same class as `users`
-- itself"). Rows are immutable except the one-time `used_at` claim, made via
-- a single conditional `UPDATE ... WHERE used_at IS NULL` (core invariant 3:
-- idempotency at the storage layer, not an in-memory check) - hence no
-- `updated_at` column, matching email_verification_tokens/
-- password_reset_tokens' shape exactly. No RLS: mirrors those two tables
-- (migration 0013 enables RLS only on audit_logs, the one table in that
-- migration that carries a - nullable - client_id).

CREATE TABLE mfa_recovery_codes (
  id          uuid PRIMARY KEY, -- app-generated uuidv7, no DB default (migration 0002 convention)
  user_id     uuid NOT NULL REFERENCES users(id),
  code_hash   bytea NOT NULL UNIQUE, -- SHA-256 of the raw recovery code; the raw code is NEVER stored
  used_at     timestamptz, -- one-time use: claimed via UPDATE ... WHERE used_at IS NULL
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id);

ALTER TABLE mfa_recovery_codes OWNER TO wp_migrator;
GRANT SELECT, INSERT, UPDATE ON mfa_recovery_codes TO wp_app;
GRANT SELECT ON mfa_recovery_codes TO wp_admin_app;
