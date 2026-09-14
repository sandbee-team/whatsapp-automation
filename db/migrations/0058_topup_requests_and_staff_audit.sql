-- P19 (topup-and-staff-audit) Unit U1 - migration 0058. Two tables:
-- `topup_requests` (a tenant's manual UPI/bank-transfer top-up submission,
-- ADR 0019 SS9 - v1 top-up is manual only, no payment gateway) and
-- `staff_audit_log` (the minimal internal-API audit trail this phase needs;
-- see the header comment on that CREATE TABLE below for the P28 contract).
--
-- topup_requests.amount_minor is bigint PAISE, never a float (same
-- discipline as every other money column - wallet.ts/wallet-guards.ts).
-- `UNIQUE (client_id, external_ref)` on a NON-partitioned table is the
-- idempotency authority (core invariant 3): a tenant re-submitting the same
-- UTR is rejected by Postgres with 23505, never by an application
-- pre-check. `method` is a `text` + CHECK, not an enum, so P28 can widen the
-- payment-method set with a cheap ALTER ... DROP/ADD CONSTRAINT instead of
-- an enum ALTER TYPE ADD VALUE (which cannot run inside the same
-- transaction as other DDL on some PG versions).
--
-- RLS idiom (both tables): ENABLE + FORCE + a `tenant_isolation` policy,
-- exactly migration 0051's `wallet_charge_guards` shape for
-- `topup_requests` (client_id NOT NULL) and migration 0013's `audit_logs`
-- shape for `staff_audit_log` (client_id NULLable - a staff action against
-- no specific tenant, e.g. approving a top-up, still carries the tenant the
-- top-up belongs to, but a future platform-level staff action might not).
--
-- Suite-A registration: `topup_requests` -> `TENANT_TABLE_COVERAGE`
-- (client_id NOT NULL); `staff_audit_log` -> `ISOLATION_NON_TENANT_TABLES`
-- (client_id NULLable), same precedent as `audit_logs` (migration 0013).

CREATE TYPE topup_status AS ENUM (
  'pending',
  'approved',
  'rejected'
);

-- ---------------------------------------------------------------------
-- 1. topup_requests - a tenant's manual top-up submission, reviewed by
-- staff via the internal API (P28 builds the review/approve mutation).
-- ---------------------------------------------------------------------
CREATE TABLE topup_requests (
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  client_id             uuid NOT NULL,
  amount_minor          bigint NOT NULL,
  method                text NOT NULL,
  external_ref          text NOT NULL, -- the UTR/reference the tenant types
  status                topup_status NOT NULL DEFAULT 'pending',
  submitted_by_user_id  uuid,
  reviewed_by_staff_id  uuid,
  review_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  reviewed_at           timestamptz,
  CONSTRAINT topup_requests_pkey PRIMARY KEY (id),
  CONSTRAINT topup_requests_amount_minor_positive CHECK (amount_minor > 0),
  CONSTRAINT topup_requests_method_check CHECK (method IN ('upi', 'bank_transfer')),
  CONSTRAINT topup_requests_client_external_ref_key UNIQUE (client_id, external_ref)
);

-- Tenant list route: WHERE client_id = $1 [AND status = $2] ORDER BY created_at DESC.
-- Deliberately NOT leading with status - the cross-tenant staff pending-queue
-- read (GET /internal/v1/topups?status=pending) runs as wp_admin_app
-- (BYPASSRLS SELECT) and does not need a status-leading index; adding one
-- here would fail suite A's "every tenant-table index leads with client_id"
-- rule (topup_requests is not on SUITE_A_INDEX_EXEMPTIONS).
CREATE INDEX topup_requests_client_status_idx
  ON topup_requests (client_id, status, created_at DESC);

ALTER TABLE topup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE topup_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON topup_requests FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE topup_requests OWNER TO wp_migrator;

-- wp_app: SELECT + INSERT only - a tenant submits a top-up request but can
-- never approve its own request (no UPDATE grant at all, on any column;
-- the phase test a_tenant_cannot_see_or_approve_another_tenants_topup_
-- request asserts this missing grant). wp_admin_app reviews/approves
-- (column-scoped UPDATE, staff-owned - the internal API runs as
-- wp_admin_app for the review mutation, same BYPASSRLS role as the staff
-- pending-queue read above). No DELETE for anyone but wp_migrator.
GRANT SELECT, INSERT ON topup_requests TO wp_app;
GRANT SELECT ON topup_requests TO wp_admin_app;
GRANT UPDATE (status, reviewed_by_staff_id, review_reason, reviewed_at)
  ON topup_requests TO wp_admin_app;

-- ---------------------------------------------------------------------
-- 2. staff_audit_log - minimal internal-API audit trail.
--
-- *** P28 must ALTER, never CREATE. *** This table is intentionally
-- minimal for P19's own needs (staff_id, action, client_id, target_ref,
-- reason, idempotency_key, request_hash, created_at). P28 (staff-audit
-- hardening) is the phase that ALTERs it to add `UNIQUE
-- (idempotency_key)`, a `target_kind` column and a `result` column - this
-- migration deliberately does NOT add those columns/constraints; adding
-- them here would preempt P28's own design and its forward-only migration
-- would then have nothing left to ALTER.
-- ---------------------------------------------------------------------
CREATE TABLE staff_audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  staff_id        uuid NOT NULL,
  action          text NOT NULL, -- dotted, e.g. 'topup.approve', 'topup.reject'
  client_id       uuid, -- NULL = platform-level action (audit_logs precedent, migration 0013)
  target_ref      text,
  reason          text NOT NULL,
  idempotency_key text,
  request_hash    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_audit_log_pkey PRIMARY KEY (id)
);

-- Non-tenant table (client_id nullable); still useful for a per-tenant
-- audit-trail read, so it still leads with client_id (audit_logs precedent).
CREATE INDEX staff_audit_log_client_created_idx
  ON staff_audit_log (client_id, created_at DESC);

ALTER TABLE staff_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON staff_audit_log FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE staff_audit_log OWNER TO wp_migrator;

-- wp_app: SELECT + INSERT - the internal API writes the audit row inside the
-- mutation's own wp_app transaction (this is exactly why the table exists -
-- the review/approve mutation and its audit row commit or roll back
-- together). No UPDATE/DELETE for anyone but wp_migrator (append-only, same
-- discipline as audit_logs).
GRANT SELECT, INSERT ON staff_audit_log TO wp_app;
GRANT SELECT ON staff_audit_log TO wp_admin_app;
