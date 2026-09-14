-- P02 (db-foundations-and-isolation) - migration 0001.
-- Extensions used across later migrations (citext for case-insensitive
-- email/text columns, pgcrypto for gen_random_uuid()/crypto helpers), and
-- the canonical enum set from the architecture blueprint + scope delta.
-- Labels are verbatim and in the exact order mirrored in
-- packages/domain/src/enums/index.ts (PG_ENUMS) and db/schema/enums.ts -
-- see db/tests/enum-parity.test.ts. No tables here. Feature enums
-- (broadcast, chat, contact) are intentionally NOT created in this
-- migration - they land with their owning feature's migration.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE job_status AS ENUM (
  'created',
  'queued',
  'processing',
  'sent',
  'failed',
  'cancelled',
  'needs_reconcile',
  'blocked_needs_review'
);

CREATE TYPE job_priority AS ENUM (
  'high',
  'normal',
  'low'
);

CREATE TYPE job_kind AS ENUM (
  'text',
  'media',
  'reply'
);

CREATE TYPE attempt_state AS ENUM (
  'prepared',
  'dispatched',
  'acked',
  'failed',
  'reconciled_sent',
  'reconciled_lost',
  'abandoned'
);

CREATE TYPE wa_health AS ENUM (
  'never_linked',
  'connected',
  'degraded',
  'paused',
  'logged_out'
);

CREATE TYPE wa_link_state AS ENUM (
  'unlinked',
  'pairing',
  'linked'
);

CREATE TYPE instance_desired_state AS ENUM (
  'online',
  'offline'
);

CREATE TYPE pause_reason AS ENUM (
  'user_action',
  'provider_restriction',
  'repeated_send_failure',
  'health_critical',
  'reconnect_failed',
  'pairing_expired',
  'session_replaced',
  'unknown_signal',
  'admin_action'
);

CREATE TYPE client_status AS ENUM (
  'pending_verification',
  'active',
  'suspended',
  'closed'
);

CREATE TYPE user_status AS ENUM (
  'active',
  'disabled'
);

CREATE TYPE membership_role AS ENUM (
  'owner',
  'admin',
  'agent',
  'viewer'
);

CREATE TYPE client_onboarding_step AS ENUM (
  'verify_email',
  'choose_timezone',
  'accept_pacing_profile',
  'attest_consent',
  'connect_whatsapp',
  'send_test',
  'done'
);

CREATE TYPE wallet_state AS ENUM (
  'active',
  'low',
  'empty',
  'frozen'
);

CREATE TYPE wallet_entry_kind AS ENUM (
  'signup_credit',
  'topup_manual',
  'topup_gateway',
  'promo_credit',
  'debit_send',
  'refund_send',
  'adjustment_credit',
  'adjustment_debit'
);
