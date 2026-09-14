-- Fixture: shaped like db/migrations/0006's SECURITY DEFINER function - a
-- CREATE FUNCTION statement's own `SET search_path = ...` attribute clause
-- (Postgres scopes and reverts this per invocation, same safety class as
-- SET LOCAL) plus a DO $$ ... $$ block. Must stay clean under sql-lint.
CREATE OR REPLACE FUNCTION public.wp_example()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT count(*) FROM public.example_table WHERE flag = 0
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wp_example') THEN
    CREATE ROLE wp_example;
  END IF;
END
$$;
