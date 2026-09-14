-- P18 (wallet-ledger-and-pricing) Unit U1 - migration 0051.
-- Three tables: wallet_charge_guards (the idempotency authority for
-- send-linked money, ADR 0019 SS1-2), wallet_daily_summary (per-tenant daily
-- rollup) and wallet_reconcile_findings (reconciler output). All money
-- columns are bigint PAISE - never floats (db/tests/wallet-guards-schema.
-- test.ts's no_money_column_is_a_floating_point_type scan). No FK to
-- message_jobs/send_attempts on wallet_charge_guards - same hot-append-path
-- deliberate omission as wallet_ledger (migration 0004).
--
-- ADR 0038 SS1: wallet_charge_guards.created_at carries NO DEFAULT. It is
-- always stamped in-statement by the writer as the charged job's OWN
-- created_at (message_jobs.created_at), never now() - a late repair for a
-- job created last month must land on THAT job's original partition, or a
-- crossed-month repair could charge the same send twice.

CREATE TABLE wallet_charge_guards (
  send_attempt_id bigint NOT NULL,
  kind wallet_entry_kind NOT NULL,
  client_id uuid NOT NULL,
  ledger_seq bigint NOT NULL DEFAULT 0, -- 0 = inserted, ledger row not yet stamped (reconciler check E hunts these)
  created_at timestamptz NOT NULL, -- NO DEFAULT, by design (ADR 0038 SS1) - see header comment above
  -- Partition key must be in the PK (mandatory test 21) - the table is on
  -- SUITE_A_INDEX_EXEMPTIONS for exactly this reason: (send_attempt_id, kind)
  -- is the real operational uniqueness authority, but a unique index on a
  -- partitioned table must carry the partition key too.
  PRIMARY KEY (send_attempt_id, kind, created_at)
) PARTITION BY RANGE (created_at);

-- Seed: previous month + current + next 2 months. The previous month is
-- seeded because the guard's created_at is the JOB's created_at, and a job
-- created late last month is legitimately charged (or repaired) this month.
SELECT public.wp_ensure_month_partition('wallet_charge_guards'::regclass, (now() - interval '1 month')::date);
SELECT public.wp_ensure_month_partition('wallet_charge_guards'::regclass, (now())::date);
SELECT public.wp_ensure_month_partition('wallet_charge_guards'::regclass, (now() + interval '1 month')::date);
SELECT public.wp_ensure_month_partition('wallet_charge_guards'::regclass, (now() + interval '2 months')::date);

-- RLS on the parent (0005 idiom). wp_ensure_month_partition already sealed
-- each child at creation time above; this re-applies idempotently over
-- every existing child too (belt and braces, same as migration 0005's own
-- wallet_ledger loop).
ALTER TABLE wallet_charge_guards ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_charge_guards FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON wallet_charge_guards FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

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
     WHERE i.inhparent = 'public.wallet_charge_guards'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', v_schema, v_table);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', v_schema, v_table);

    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policies
       WHERE schemaname = v_schema AND tablename = v_table AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I.%I FOR ALL '
        || 'USING (client_id = nullif(current_setting(%L, true), %L)::uuid) '
        || 'WITH CHECK (client_id = nullif(current_setting(%L, true), %L)::uuid)',
        v_schema, v_table, 'app.client_id', '', 'app.client_id', ''
      );
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE wallet_charge_guards OWNER TO wp_migrator;

-- wp_app: SELECT + INSERT is the guard-first debit path's own write surface;
-- UPDATE is restricted to ledger_seq only (the column the ledger-write step
-- stamps after inserting the guard row) - never send_attempt_id/kind/
-- client_id/created_at, which are write-once at INSERT time. NO DELETE for
-- anyone but wp_migrator (append-only, same discipline as wallet_ledger).
GRANT SELECT, INSERT ON wallet_charge_guards TO wp_app;
GRANT UPDATE (ledger_seq) ON wallet_charge_guards TO wp_app;
GRANT SELECT ON wallet_charge_guards TO wp_admin_app;

CREATE TABLE wallet_daily_summary (
  client_id uuid NOT NULL,
  day date NOT NULL, -- UTC calendar day of wallet_ledger.created_at
  instance_id uuid NOT NULL, -- NOT NULL inside the PK; the workspace total is SUM(), never a NULL-instance row
  sent_count int NOT NULL DEFAULT 0,
  debit_minor bigint NOT NULL DEFAULT 0,
  credit_minor bigint NOT NULL DEFAULT 0,
  refund_minor bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, day, instance_id)
);

ALTER TABLE wallet_daily_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_daily_summary FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON wallet_daily_summary FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE wallet_daily_summary OWNER TO wp_migrator;

-- wp_app: the rollup upserts per tenant as wp_app (SELECT for read-back,
-- INSERT + UPDATE for the upsert itself). No DELETE.
GRANT SELECT, INSERT, UPDATE ON wallet_daily_summary TO wp_app;
GRANT SELECT ON wallet_daily_summary TO wp_admin_app;

CREATE TABLE wallet_reconcile_findings (
  client_id uuid NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL, -- 'continuity_break' | 'balance_mismatch' | 'missing_debit' | 'missing_debit_repaired' |
                       -- 'missing_debit_capped' | 'orphan_debit' | 'rollup_parity' | 'orphan_guard'
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  amount_minor bigint,
  corrected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, id) -- leads with client_id (suite A index-lead rule; an id-only PK would fail it)
);
CREATE INDEX wallet_reconcile_findings_client_created_idx ON wallet_reconcile_findings (client_id, created_at);

ALTER TABLE wallet_reconcile_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_reconcile_findings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON wallet_reconcile_findings FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE wallet_reconcile_findings OWNER TO wp_migrator;

-- wp_app: SELECT + INSERT is the reconciler's own write surface; UPDATE is
-- restricted to corrected_at only (marking a finding as corrected) - never
-- kind/detail/amount_minor/created_at, write-once at INSERT time.
GRANT SELECT, INSERT ON wallet_reconcile_findings TO wp_app;
GRANT UPDATE (corrected_at) ON wallet_reconcile_findings TO wp_app;
GRANT SELECT ON wallet_reconcile_findings TO wp_admin_app;
