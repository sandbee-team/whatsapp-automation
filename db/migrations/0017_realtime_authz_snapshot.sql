-- P05 (panel-shell-and-sse) Unit U0 - migration 0017.
--
-- The SSE re-authorisation tick (P05 Unit U3b) runs on a background path: a
-- scheduled job that, at most every 5s, takes the DISTINCT set of user ids
-- currently holding an open SSE stream and decides, per user, whether to
-- drop their connection (membership revoked, workspace suspended, or a
-- security-relevant session invalidation signalled via `users.token_epoch`
-- - migration 0013 - having advanced past the epoch the stream was opened
-- under). That tick has no per-request tenant context: it is not inside a
-- `SET LOCAL app.client_id = ...` transaction for any one client, because it
-- is deciding across MANY clients' users in a single batched call.
--
-- `memberships` and `clients` are FORCE ROW LEVEL SECURITY (migration 0005)
-- and the api runs this path as `wp_app`, which has no BYPASSRLS. With no
-- `app.client_id` GUC set, the `tenant_isolation` policy on both tables
-- evaluates to false for every row, so a plain
--   SELECT ... FROM memberships WHERE user_id = ANY($1)
-- under wp_app returns ZERO rows for every user, including ones with a live
-- membership - i.e. it looks identical to "every user just lost their
-- membership" and the caller would drop every stream. Exactly the "unclear
-- provider/account state -> pause" trap, just at the authz layer instead of
-- the send path: fail-unclear must never look like fail-revoked.
--
-- `wp_realtime_authz_snapshot(p_user_ids uuid[])` breaks that the same way
-- `wp_client_id_for_user` (migration 0015) breaks the identity-bootstrap
-- version of this problem: a SECURITY DEFINER function, pinned search_path
-- (migration 0006 - a mutable search_path on a definer function is a
-- privilege-escalation primitive), owned by `wp_admin_app` (BYPASSRLS - see
-- migration 0005 section 4's `wp_zero_max_rate_wallet_count` precedent; a
-- definer function that reads an RLS-protected table needs an owner that
-- actually bypasses RLS or it just inherits the same "zero rows" problem it
-- exists to solve), REVOKEd from PUBLIC, and EXECUTE-granted only to the
-- exact role that runs this path (wp_app - not wp_scheduler, not
-- wp_admin_app itself, which already bypasses RLS directly and has no need
-- to call through a definer to do so).
--
-- Return contract, one row per requested user id where the user still
-- exists, LEFT JOINed to their membership/client:
--   - A user with NO membership row still returns a row, with
--     client_id/client_status NULL - that IS the "membership revoked" (or
--     never had one) signal the caller drops the stream on. It must not be
--     silently absent, or the caller cannot tell "revoked" apart from
--     "user id doesn't exist" (see next line) without a second query.
--   - A user id that does not exist in `users` at all returns NO row -
--     itself also a drop signal (deleted/never-existed user), just a
--     different one the caller distinguishes by absence from the result set
--     rather than by a NULL column.
--   - `memberships_one_workspace_per_user_uq` (migration 0002) guarantees at
--     most one membership row per user, so this LEFT JOIN can never fan out
--     to more than one row per requested user id.
CREATE OR REPLACE FUNCTION public.wp_realtime_authz_snapshot(p_user_ids uuid[])
RETURNS TABLE (user_id uuid, token_epoch integer, client_id uuid, client_status client_status)
LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.token_epoch, m.client_id, c.status
  FROM public.users u
  LEFT JOIN public.memberships m ON m.user_id = u.id
  LEFT JOIN public.clients c ON c.id = m.client_id
  WHERE u.id = ANY (p_user_ids)
$$;

ALTER FUNCTION public.wp_realtime_authz_snapshot(uuid[]) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_realtime_authz_snapshot(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_realtime_authz_snapshot(uuid[]) TO wp_app;
