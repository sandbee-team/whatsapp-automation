-- P02 (db-foundations-and-isolation) - migration 0005.
-- RLS, four roles, grants. This is the migration that makes every earlier
-- FORCE ROW LEVEL SECURITY meaningful: without an ownership transfer away
-- from the migration superuser AND non-superuser, non-BYPASSRLS roles for
-- every application access path, RLS silently does not apply (table owners
-- and superusers bypass RLS unless FORCE is set, and FORCE itself does
-- nothing for a role that still owns the table or holds BYPASSRLS). No plain
-- SET anywhere below (sql-lint bans it) - current_setting()/nullif()/
-- set_config() are the sanctioned per-statement forms; DO blocks use
-- dynamic EXECUTE so every step is idempotent and this file can be read top
-- to bottom on a fresh database exactly like 0001-0004.

-- ---------------------------------------------------------------------
-- 1. Roles (cluster-level - guarded so re-running this migration, or
--    applying it against another database in the same cluster, never
--    double-creates a role). All four are NOLOGIN: production LOGIN
--    configuration (passwords, connection limits) is an ops concern, not
--    schema. Tests use `SET LOCAL ROLE <name>` inside a transaction, which
--    does not require LOGIN.
-- ---------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wp_migrator') THEN
    CREATE ROLE wp_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wp_app') THEN
    CREATE ROLE wp_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wp_scheduler') THEN
    CREATE ROLE wp_scheduler NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wp_admin_app') THEN
    CREATE ROLE wp_admin_app NOLOGIN;
  END IF;
END;
$$;

-- Idempotent either way: sets the attribute if unset, no-ops if already set.
-- ONLY wp_admin_app carries BYPASSRLS - wp_migrator, wp_app and wp_scheduler
-- must never get it, or FORCE ROW LEVEL SECURITY becomes a no-op for them.
ALTER ROLE wp_admin_app BYPASSRLS;

-- ---------------------------------------------------------------------
-- 2. Ownership transfer. FORCE ROW LEVEL SECURITY does not apply to the
--    table owner (nor to a superuser) - so every existing public table,
--    partition, sequence and the pre-existing wp_* helper function moves to
--    wp_migrator, a DDL-only role nothing ever connects to the database as.
--    Extension-owned objects (citext/pgcrypto members) are skipped via the
--    pg_depend extension-membership check - reassigning those is not ours
--    to do and is unnecessary (the extensions do not create tables in
--    public.).
-- ---------------------------------------------------------------------

DO $$
DECLARE
  v_relname name;
  v_relkind "char";
BEGIN
  FOR v_relname, v_relkind IN
    SELECT c.relname, c.relkind
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'S')
       AND NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_depend d
              WHERE d.objid = c.oid
                AND d.deptype = 'e'
           )
  LOOP
    IF v_relkind = 'S' THEN
      EXECUTE format('ALTER SEQUENCE public.%I OWNER TO wp_migrator', v_relname);
    ELSE
      EXECUTE format('ALTER TABLE public.%I OWNER TO wp_migrator', v_relname);
    END IF;
  END LOOP;
END;
$$;

-- The one wp_* function that exists as of migration 0004. The boot-gate
-- function created later in this file is owned by wp_admin_app instead (see
-- section 4) - it is never transferred to wp_migrator.
ALTER FUNCTION public.wp_ensure_month_partition(regclass, date) OWNER TO wp_migrator;

-- ---------------------------------------------------------------------
-- 3. Row level security. Tenant tables get ENABLE + FORCE + a single
--    `tenant_isolation` policy `FOR ALL`, predicate on `client_id` (on
--    `clients` itself, the predicate keys on `id`). Created only if absent,
--    same idempotent shape as `wp_ensure_month_partition` (migration 0003).
--    NON-tenant tables (users, plans, plan_limits, price_lists,
--    price_list_items, schema_migrations) intentionally get no RLS here.
-- ---------------------------------------------------------------------

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'public' AND tablename = 'clients' AND policyname = 'tenant_isolation'
  ) THEN
    -- nullif(..., '') is non-negotiable: current_setting(key, true) returns
    -- '' when app.client_id is unset, and ''::uuid raises - a policy that
    -- throws instead of returning zero rows is a fail-open bug.
    CREATE POLICY tenant_isolation ON public.clients FOR ALL
      USING (id = nullif(current_setting('app.client_id', true), '')::uuid)
      WITH CHECK (id = nullif(current_setting('app.client_id', true), '')::uuid);
  END IF;
END;
$$;

-- The remaining tenant tables all key on client_id - looped to keep the
-- five identical bodies from drifting from each other.
DO $$
DECLARE
  v_table name;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'memberships',
    'client_pricing',
    'wallet_accounts',
    'wallet_ledger',
    'wallet_ledger_ext_refs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_table);

    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policies
       WHERE schemaname = 'public' AND tablename = v_table AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I FOR ALL '
        || 'USING (client_id = nullif(current_setting(%L, true), %L)::uuid) '
        || 'WITH CHECK (client_id = nullif(current_setting(%L, true), %L)::uuid)',
        v_table, 'app.client_id', '', 'app.client_id', ''
      );
    END IF;
  END LOOP;
END;
$$;

-- wallet_ledger is partitioned: a partition queried directly (bypassing the
-- parent) does NOT inherit the parent's policy, so every existing partition
-- needs its own copy too. The three partitions migration 0004 created were
-- already sealed by wp_ensure_month_partition at creation time - this loop
-- re-applies idempotently over whatever children exist today, so it stays
-- correct even if that ever changes.
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
     WHERE i.inhparent = 'public.wallet_ledger'::regclass
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

-- ---------------------------------------------------------------------
-- 4. Boot-gate function. `app/backend/src/platform/db/assert-db-
--    preconditions.ts` calls this at every non-migrate boot to refuse to
--    serve traffic while any wallet_accounts row has max_rate_minor = 0
--    (ADR 0019 SS1).
--
--    CRITICAL SUBTLETY: under FORCE ROW LEVEL SECURITY even the table
--    owner is policy-bound - only a BYPASSRLS role escapes it. A
--    SECURITY DEFINER function runs with the privileges of its OWNER, so
--    if this function were owned by wp_migrator (no BYPASSRLS), the
--    `SELECT count(*) FROM wallet_accounts` inside it would be filtered by
--    tenant_isolation with no `app.client_id` set - nullif(...) then makes
--    the predicate `client_id = NULL`, which matches zero rows - and the
--    boot gate would count 0 forever and fail OPEN. Owning it as
--    wp_admin_app (BYPASSRLS) is what makes the gate actually see every
--    row.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.wp_zero_max_rate_wallet_count()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT count(*) FROM public.wallet_accounts WHERE max_rate_minor = 0
$$;

ALTER FUNCTION public.wp_zero_max_rate_wallet_count() OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_zero_max_rate_wallet_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_zero_max_rate_wallet_count() TO wp_app, wp_scheduler, wp_admin_app;

-- ---------------------------------------------------------------------
-- 5. Grants. Explicit, per-table, per-role - no ALTER DEFAULT PRIVILEGES.
--    Future tables are granted in their own migrations so the schema-parity/
--    grant-snapshot tests catch drift instead of silently inheriting a
--    default.
-- ---------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO wp_app, wp_scheduler, wp_admin_app; -- wp_migrator owns the schema's objects already

-- wp_app: the application role. No BYPASSRLS anywhere - every row it
-- touches is policy-checked via tenant_isolation.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.clients, public.memberships, public.client_pricing
  TO wp_app;
-- No DELETE on users/wallet_accounts: accounts and users are never
-- hard-deleted by the application.
GRANT SELECT, INSERT, UPDATE ON public.users, public.wallet_accounts TO wp_app;
-- Append-only is enforced as a GRANT, not an application habit (core
-- invariant 3): wp_app can INSERT ledger rows but can never UPDATE or
-- DELETE one, at the database level.
GRANT SELECT, INSERT ON public.wallet_ledger, public.wallet_ledger_ext_refs TO wp_app;
GRANT SELECT
  ON public.plans, public.plan_limits, public.price_lists, public.price_list_items,
     public.schema_migrations
  TO wp_app;
-- Deliberately NOT granted to wp_app: direct access to any wallet_ledger
-- partition child. All application access to ledger data goes through the
-- parent; wp_app staying unable to read/write a child table directly is a
-- feature, not an oversight.

-- wp_scheduler: narrow by design today. Its real surface (message_jobs,
-- whatsapp_instances poll columns) arrives with P03; schema_migrations only
-- for now, so the role is usable in tooling/tests without erroring on "no
-- privilege on any relation".
GRANT SELECT ON public.schema_migrations TO wp_scheduler;

-- wp_admin_app: BYPASSRLS platform-read surface for the admin panel/ops
-- tooling. SELECT on every current public table (including wallet_ledger's
-- partition children, swept in by "ALL TABLES" - acceptable, reads only).
-- Zero write grants anywhere, on any table, ever.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO wp_admin_app;

-- wp_ensure_month_partition stays owner-(wp_migrator)-only: EXECUTE is
-- revoked from PUBLIC and granted to no one here. P03 decides whether
-- wp_scheduler needs to call it directly when message_jobs partitions
-- arrive.
REVOKE ALL ON FUNCTION public.wp_ensure_month_partition(regclass, date) FROM PUBLIC;

-- ---------------------------------------------------------------------
-- 6. The four-role model, one line each:
--    wp_migrator  - owns every object; the only role that runs DDL/migrations.
--    wp_app       - the API/worker role; RLS-bound, no BYPASSRLS, append-only
--                    on the wallet ledger, never a hard-delete on users/wallets.
--    wp_scheduler - the dispatch loop's role; narrow SELECT-only surface,
--                    grown table-by-table as its poll queries are built.
--    wp_admin_app - the admin/ops read surface; BYPASSRLS so staff can see
--                    across tenants, but SELECT-only - it can never write.
-- ---------------------------------------------------------------------
