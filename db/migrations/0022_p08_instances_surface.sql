-- P08 (session-lifecycle) Unit U3 - migration 0022.
-- Forward-only, additive-or-justified. Two items, both scoped to
-- whatsapp_instances/its surface, bundled per the dispatch.

-- ---------------------------------------------------------------------
-- ITEM 1 - drop the leftover `owner_worker_id` column (P06-carried item,
-- flagged as "P08's problem" in migration 0018's header and left untouched
-- there). Lease ownership has lived in
-- `instance_lease_state.owner_worker_id` since migration 0018; nothing has
-- ever written `whatsapp_instances.owner_worker_id` - it was carried over
-- from the 0010 shell and never wired to any query. Verified before this
-- migration: no migration ever GRANTed this specific column (0010 gave
-- wp_scheduler a narrow SELECT list that never included it; 0010/0012 gave
-- wp_admin_app only a table-level SELECT *, which the DROP simply narrows;
-- migration 0012's wp_scheduler column-grant narrowing pass on
-- message_jobs/clients/wallet_accounts did not touch whatsapp_instances at
-- all - it explicitly left that table's grant alone as already-narrow). So
-- the DROP does not require any accompanying REVOKE - a dropped column
-- disappears from every grant (table- or column-level) that mentioned it
-- automatically, and the grants snapshot refresh captures that as the only
-- diff. `instance_lease_state.owner_worker_id` (the real column) is not
-- touched by this migration.
-- ---------------------------------------------------------------------
ALTER TABLE whatsapp_instances DROP COLUMN owner_worker_id;

-- ---------------------------------------------------------------------
-- ITEM 2 - wp_session_bootstrap_scan: read-only discovery-scan definer
-- function for the P08 bootstrap sweep (worker scans pairing-intent
-- instances across every tenant). Same class of cross-tenant read as
-- migration 0018/0019's wp_lease_scan_unowned, same ADR 0029 precedent
-- applied here: owned by wp_admin_app (BYPASSRLS - a tenant-scoped owner
-- would just re-inherit the "zero rows with no app.client_id GUC set"
-- problem this function exists to solve), pinned
-- `search_path = pg_catalog, public` (mutable search_path on a SECURITY
-- DEFINER function is a privilege-escalation primitive per migration 0006),
-- REVOKE ALL FROM PUBLIC, EXECUTE granted to wp_scheduler only - matching
-- wp_lease_scan_unowned's precedent exactly (that function does not grant
-- wp_app EXECUTE either, so this one does not either).
--
-- Read-only, projects exactly (instance_id, client_id) - no other column of
-- whatsapp_instances is exposed. Row filter is narrower than
-- wp_lease_scan_unowned's (pairing-intent discovery only, not general
-- unowned-instance discovery): `desired_state = 'online'` (the client wants
-- this instance connected), `link_state = 'pairing'` (mid-QR-linking, the
-- state this scan exists to find), `deleted_at IS NULL`. Ordered by
-- `pairing_started_at ASC` (oldest-pairing-first - fail-safe: a
-- pairing attempt that has been stuck longest gets picked up first, instead
-- of `ORDER BY random()` starving it indefinitely) and bounded by
-- `LEAST(GREATEST(max_rows, 1), 50)` - floors a non-positive input to 1
-- row (never "select everything") and ceilings at 50 (this is a narrow
-- pairing-intent sweep, not the general fleet-wide discovery
-- wp_lease_scan_unowned already covers - P09 replaces this scan with full
-- discovery under admission control, at which point a larger ceiling is
-- that phase's decision to make, not this one's).
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_session_bootstrap_scan(max_rows int)
RETURNS TABLE (instance_id uuid, client_id uuid)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT i.id, i.client_id
    FROM public.whatsapp_instances i
   WHERE i.desired_state = 'online'
     AND i.link_state = 'pairing'
     AND i.deleted_at IS NULL
   ORDER BY i.pairing_started_at ASC
   LIMIT least(greatest(max_rows, 1), 50)
$$;

ALTER FUNCTION public.wp_session_bootstrap_scan(int) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_session_bootstrap_scan(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_session_bootstrap_scan(int) TO wp_scheduler;
