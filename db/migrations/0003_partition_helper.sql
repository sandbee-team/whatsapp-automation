-- P02 (db-foundations-and-isolation) - migration 0003.
-- The monthly-partition helper. wp_ensure_month_partition(parent, month)
-- creates the <parent>_yYYYYmMM partition for the given month if it does
-- not already exist, and then - unconditionally but idempotently - seals
-- the partition with ENABLE + FORCE ROW LEVEL SECURITY and the canonical
-- `tenant_isolation` policy. A partition queried directly (bypassing the
-- parent) does NOT inherit the parent's RLS policy, so every partition
-- must carry its own copy. P03 reuses this for message_jobs; wallet_ledger
-- is the next caller. No plain SET anywhere below (sql-lint bans it) -
-- current_setting()/nullif() are the sanctioned per-statement forms.

CREATE OR REPLACE FUNCTION public.wp_ensure_month_partition(parent regclass, month date)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_schema          name;
  v_parent_name     name;
  v_partition_name  text;
  v_full_name       text;
  v_from            timestamptz;
  v_to              timestamptz;
BEGIN
  SELECT n.nspname, c.relname
    INTO v_schema, v_parent_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = parent;

  v_partition_name := v_parent_name || '_y' || to_char(month, 'YYYY') || 'm' || to_char(month, 'MM');
  v_full_name := format('%I.%I', v_schema, v_partition_name);

  v_from := date_trunc('month', month)::timestamptz;
  v_to := (date_trunc('month', month) + interval '1 month')::timestamptz;

  IF to_regclass(v_full_name) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
      v_schema, v_partition_name, v_schema, v_parent_name, v_from, v_to
    );
  END IF;

  -- No-ops when already set - safe to run on every call, including on a
  -- partition that pre-existed the IF block above (created some other way).
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', v_schema, v_partition_name);
  EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', v_schema, v_partition_name);

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policies
     WHERE schemaname = v_schema
       AND tablename = v_partition_name
       AND policyname = 'tenant_isolation'
  ) THEN
    -- nullif(..., '') is non-negotiable: current_setting(key, true) can
    -- return '' when app.client_id is unset, and ''::uuid raises - a policy
    -- that throws instead of returning zero rows is a fail-open bug.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I FOR ALL '
      || 'USING (client_id = nullif(current_setting(%L, true), %L)::uuid) '
      || 'WITH CHECK (client_id = nullif(current_setting(%L, true), %L)::uuid)',
      v_schema, v_partition_name, 'app.client_id', '', 'app.client_id', ''
    );
  END IF;
END;
$fn$;
