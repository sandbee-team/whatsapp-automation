-- P02 (db-foundations-and-isolation) - migration 0004.
-- Wallet and pricing. Created here, not in P18, because the P04 signup
-- transaction provisions a wallet row as part of onboarding (scope-delta
-- migration-placement rule) - wallet LOGIC (debit/credit transactions,
-- low-balance/empty transitions, checkpointing) lands in P18/P19. Tables:
-- price_lists/price_list_items (global price catalog), client_pricing (per
-- client override pointer), wallet_accounts (one row per client), and the
-- append-only wallet_ledger plus its non-partitioned external-ref uniqueness
-- side table. All money columns are bigint PAISE - never floats (see
-- db/tests/wallet-schema.test.ts's generic no-floating-point-money scan).

CREATE TABLE price_lists (
  key text PRIMARY KEY,
  name text NOT NULL,
  currency char(3) NOT NULL DEFAULT 'INR',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE price_list_items (
  price_list_key text NOT NULL REFERENCES price_lists(key),
  price_key text NOT NULL,
  rate_minor bigint NOT NULL CHECK (rate_minor > 0), -- PAISE; bigint; never floats
  PRIMARY KEY (price_list_key, price_key)
);

CREATE TABLE client_pricing (
  client_id uuid PRIMARY KEY REFERENCES clients(id),
  price_list_key text NOT NULL REFERENCES price_lists(key),
  override_items jsonb NOT NULL DEFAULT '{}'::jsonb, -- staff-set with reason+audit (P18/P28); empty by default
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_accounts (
  client_id uuid PRIMARY KEY REFERENCES clients(id),
  currency char(3) NOT NULL DEFAULT 'INR',
  balance_minor bigint NOT NULL DEFAULT 0,
  state wallet_state NOT NULL DEFAULT 'active',
  low_balance_threshold_minor bigint NOT NULL DEFAULT 5000,
  max_rate_minor bigint NOT NULL CHECK (max_rate_minor > 0), -- NO DEFAULT, by design: set in the signup txn (ADR 0019 S1)
  entry_seq bigint NOT NULL DEFAULT 0,
  checkpoint_seq bigint NOT NULL DEFAULT 0,
  checkpoint_balance_minor bigint NOT NULL DEFAULT 0,
  lifetime_credit_minor bigint NOT NULL DEFAULT 0,
  lifetime_debit_minor bigint NOT NULL DEFAULT 0,
  last_low_warning_at timestamptz,
  last_empty_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 70);

-- The PK below is (client_id, seq, created_at), NOT the (client_id, seq)
-- the blueprint text names, because a unique constraint on a partitioned
-- table must include every partition-key column - Postgres rejects a PK
-- that omits created_at here, and mandatory test 21 (db/tests/partitions.
-- test.ts) exists precisely to police that rule repo-wide. Operational
-- (client_id, seq) uniqueness - the thing the blueprint actually cares
-- about - is enforced procedurally instead: seq is allocated from
-- wallet_accounts.entry_seq under that row's lock (P18 builds the
-- allocator), so two ledger rows for the same client can never collide on
-- seq even though the database itself cannot express that as a constraint.
CREATE TABLE wallet_ledger (
  client_id uuid NOT NULL,
  seq bigint NOT NULL,
  kind wallet_entry_kind NOT NULL,
  amount_minor bigint NOT NULL, -- signed: credit > 0, debit < 0
  balance_after_minor bigint NOT NULL,
  price_key text,
  rate_minor bigint,
  quantity int NOT NULL DEFAULT 1,
  instance_id uuid,
  campaign_id uuid,
  message_job_id bigint,
  message_job_created_at timestamptz,
  send_attempt_id bigint,
  actor_type text NOT NULL,
  actor_user_id uuid,
  actor_staff_id uuid,
  reason text,
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, seq, created_at)
) PARTITION BY RANGE (created_at);
-- APPEND-ONLY table: migration 0005 revokes UPDATE/DELETE from wp_app. No FK
-- on the hot append path (deliberate; wallet_accounts/client_pricing already
-- carry the FK relationship to clients).

-- Current + next 2 months, via the step-5 helper (migration 0003).
SELECT public.wp_ensure_month_partition('wallet_ledger'::regclass, (now())::date);
SELECT public.wp_ensure_month_partition('wallet_ledger'::regclass, (now() + interval '1 month')::date);
SELECT public.wp_ensure_month_partition('wallet_ledger'::regclass, (now() + interval '2 months')::date);

-- The NON-partitioned external_ref uniqueness authority: wallet_ledger itself
-- is partitioned by created_at, so a UNIQUE (client_id, external_ref) index
-- on it could only ever be per-partition-unique, not globally unique (the
-- same trap mandatory test 21 polices) - this side table is where global
-- external_ref idempotency actually lives.
CREATE TABLE wallet_ledger_ext_refs (
  client_id uuid NOT NULL,
  external_ref text NOT NULL,
  seq bigint NOT NULL, -- pointer to the ledger row it guards
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, external_ref)
);

-- PLACEHOLDER: founder sets the real numbers (scope delta, open question 1).
-- Internal-only until then; pricing copy is owned by P18/P23/P29.
INSERT INTO price_lists (key, name) VALUES ('default_inr', 'Default INR');
INSERT INTO price_list_items (price_list_key, price_key, rate_minor) VALUES
  ('default_inr', 'text', 15),
  ('default_inr', 'media', 25),
  ('default_inr', 'group_text', 15),
  ('default_inr', 'group_media', 25);
