-- P04a FIXA (C1 review fixes) - migration 0015.
-- FIX 1: the identity path (login/session/verify-email/lockout) reads/writes
-- TENANT tables (memberships, clients, audit_logs) but runs pre-tenant-
-- context, on a plain connection with no `app.client_id` GUC set - under
-- `wp_app` + FORCE ROW LEVEL SECURITY (migration 0005) every one of those
-- reads returns zero rows and every one of those writes violates the
-- `tenant_isolation` policy's WITH CHECK.
--
-- `wp_client_id_for_user(p_user_id uuid)` breaks that bootstrap problem:
-- resolves the ONE client a user belongs to (one-workspace-per-user -
-- `memberships_one_workspace_per_user_uq`, migration 0002 - makes this
-- total, never ambiguous) with NO `app.client_id` GUC required, so the
-- application code can call it FIRST, then `set_config('app.client_id', ...)`
-- with the answer before running any further tenant-scoped reads/writes in
-- the same transaction.
--
-- Definer conventions copied EXACTLY from migration 0006 (search_path
-- pinning) and 0005 section 4 (BYPASSRLS ownership rationale): a SECURITY
-- DEFINER function with a mutable search_path is a privilege-escalation
-- primitive (0006), and a SECURITY DEFINER function that reads an
-- RLS-protected table needs an owner that actually bypasses RLS or it just
-- inherits the same "zero rows with no GUC set" problem it exists to solve
-- (0005 section 4's `wp_zero_max_rate_wallet_count` precedent) - hence
-- `wp_admin_app` ownership, not `wp_migrator`.

CREATE OR REPLACE FUNCTION public.wp_client_id_for_user(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT client_id FROM public.memberships WHERE user_id = p_user_id LIMIT 1
$$;

ALTER FUNCTION public.wp_client_id_for_user(uuid) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_client_id_for_user(uuid) FROM PUBLIC;
-- Exactly the role the identity API path runs as - no wider (not
-- wp_scheduler, not wp_admin_app itself: wp_admin_app already bypasses RLS
-- and has no need to call through a definer to do so).
GRANT EXECUTE ON FUNCTION public.wp_client_id_for_user(uuid) TO wp_app;
