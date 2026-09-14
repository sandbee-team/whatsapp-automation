-- P02 (db-foundations-and-isolation) - migration 0002.
-- Tenancy core: plans/plan_limits, users, clients, memberships. IDs are
-- app-generated uuidv7 (see ADR on id generation) - uuid PKs get NO DB
-- default. `instance_grants` is intentionally NOT created here (ADR 0017 S5
-- collapses it out of the default path; scope-delta open question 9). No
-- RLS/roles/grants yet - migration 0005 owns that.

CREATE TABLE plans (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_limits (
  plan_id uuid PRIMARY KEY REFERENCES plans(id),
  max_connected_instances int NOT NULL,
  max_registered_instances int NOT NULL, -- convention: 3 x connected slots; cross-column defaults are app-side, hence the CHECK
  max_broadcast_recipients int NOT NULL DEFAULT 20000,
  CHECK (max_connected_instances > 0),
  CHECK (max_registered_instances >= max_connected_instances)
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  full_name text NOT NULL,
  email citext NOT NULL UNIQUE,
  phone_e164 text,
  phone_verified_at timestamptz,
  status user_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clients (
  id uuid PRIMARY KEY,
  company_name text NOT NULL,
  slug citext NOT NULL UNIQUE,
  status client_status NOT NULL DEFAULT 'pending_verification',
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  plan_id uuid REFERENCES plans(id),
  onboarding_step client_onboarding_step NOT NULL DEFAULT 'verify_email',
  owner_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE memberships (
  client_id uuid NOT NULL REFERENCES clients(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role membership_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, user_id) -- natural key; leads with the tenant key (suite-A index rule); nothing references memberships
);

-- The ENTIRE single-workspace-per-user enforcement lives here - no app-level
-- check may duplicate it (see db/tests/tenancy.test.ts).
CREATE UNIQUE INDEX memberships_one_workspace_per_user_uq ON memberships (user_id);
