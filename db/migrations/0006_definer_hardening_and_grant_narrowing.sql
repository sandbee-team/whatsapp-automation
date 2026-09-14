-- P02 C1 review fixes (findings M2 + M4). Forward-only, additive to the
-- 0005 grant/role model - no table drop, no data loss. Two independent
-- hardenings:
--
--   M2: the boot-gate function (public.wp_zero_max_rate_wallet_count) is
--   SECURITY DEFINER, owned by wp_admin_app (BYPASSRLS) - see 0005 section 4
--   for why that ownership is required. A SECURITY DEFINER function with a
--   mutable search_path is a privilege-escalation primitive: a caller with
--   CREATE on some schema earlier in the resolved search_path can shadow
--   `count` or `wallet_accounts` and have the definer's elevated privilege
--   execute attacker-controlled code/objects. Pinning `search_path` on the
--   function itself closes that door regardless of the caller's session
--   search_path. This is the house rule for every future definer function,
--   not a one-off.
--
--   M4: least privilege on wp_app. client_pricing is the tenant's rate
--   card - ADR 0019 SS11 says tenant-side code must never rewrite its own
--   rate card, and P04 signup only ever INSERTs a row; UPDATE/DELETE on
--   client_pricing should never have been in wp_app's grant set. clients
--   carries deleted_at (soft-delete) - a hard DELETE bypasses that design
--   entirely and has no legitimate caller in wp_app's role.
--
-- Recreating the function requires re-doing the two ALTER/GRANT statements
-- that follow it in 0005: CREATE OR REPLACE, run as the migration
-- superuser, resets ownership to that superuser, and a fresh function starts
-- with the default REVOKE-ALL-from-PUBLIC/no-grants state.

-- ---------------------------------------------------------------------
-- 1. Boot-gate function: pinned search_path.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.wp_zero_max_rate_wallet_count()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT count(*) FROM public.wallet_accounts WHERE max_rate_minor = 0
$$;

ALTER FUNCTION public.wp_zero_max_rate_wallet_count() OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_zero_max_rate_wallet_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_zero_max_rate_wallet_count() TO wp_app, wp_scheduler, wp_admin_app;

-- ---------------------------------------------------------------------
-- 2. wp_app grant narrowing.
-- ---------------------------------------------------------------------

-- Tenant-side code must never rewrite its own rate card (ADR 0019 SS11);
-- P04 signup only ever INSERTs a client_pricing row.
REVOKE UPDATE, DELETE ON public.client_pricing FROM wp_app;

-- clients has deleted_at soft-delete; a hard DELETE is against the table's
-- design and has no legitimate wp_app caller.
REVOKE DELETE ON public.clients FROM wp_app;
