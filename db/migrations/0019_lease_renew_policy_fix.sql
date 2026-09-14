-- P06 (session-lease-and-fence) C1 fix - migration 0019.
-- FORWARD-ONLY on top of 0018 (immutable, applied - never edit 0018).
--
-- ---------------------------------------------------------------------
-- Defect (C1 reviewer finding 1): `lease_owner_renew` from 0018 is a
-- FOR UPDATE-only policy. Postgres requires every row an UPDATE's
-- WHERE/RETURNING clause can even LOOK AT to also be visible under a
-- FOR SELECT/FOR ALL policy - not just the FOR UPDATE policy's own
-- USING clause. The only SELECT policy on this table is `tenant_isolation`
-- (keyed on `app.client_id`), which a worker-scoped renew transaction never
-- sets (it only sets `app.worker_id` - see lease-state-repo.ts's
-- renewBatch). Result verified live against the dev DB before this
-- migration: the batched cross-tenant renew UPDATE always returns ZERO
-- rows under `wp_app` with only `app.worker_id` set, which self-fence.ts
-- then correctly (by its own logic) reads as a fence conflict on EVERY
-- held lease - a fleet-wide self-fence storm on the very first wired
-- heartbeat tick.
--
-- Fix: split into TWO worker-scoped policies (FOR UPDATE, FOR SELECT),
-- both keyed on the same `app.worker_id` GUC predicate, instead of one
-- combined policy.
--
-- Why NOT one `FOR ALL` policy (the obvious-looking shortcut): Postgres
-- RLS policies on the same command are OR-ed together. A `FOR ALL`
-- policy's WITH CHECK also gates INSERT. If a single `FOR ALL` policy were
-- keyed on `owner_worker_id = current_setting('app.worker_id')`, then ANY
-- wp_app connection that sets `app.worker_id` (which every worker
-- connection does, for the renew path) would satisfy that WITH CHECK for
-- an INSERT into instance_lease_state for an ARBITRARY tenant/instance -
-- as long as the inserted row's `owner_worker_id` matches the GUC. That
-- would bypass `tenant_isolation`'s WITH CHECK entirely on the INSERT
-- (mint) path, because RLS policies for the same command are permissive-OR:
-- satisfying EITHER policy's WITH CHECK is enough. Splitting into
-- UPDATE-only and SELECT-only (leaving INSERT ungoverned by any
-- worker-scoped policy) keeps INSERT gated by `tenant_isolation` alone,
-- exactly as ADR 0029 SS3 / migration 0018's grants intended (`wp_app`'s
-- INSERT grant on this table is tenant-scoped mint only).
--
-- Honest, bounded exposure this widens (must be stated, not hidden): with
-- `app.worker_id` set and no `app.client_id` set, a `wp_app` connection can
-- now SELECT the FULL ROW (every column) and UPDATE the four
-- column-granted lease-liveness columns (current_fence, owner_worker_id,
-- lease_seen_at, released_at per 0018's column grant) of every lease row
-- that worker currently owns, ACROSS TENANTS. This is strictly the
-- lease-liveness control-plane surface ADR 0029 already accepted as
-- necessary for the mandated one-statement batched renew (ADR 0018 SS4 /
-- scope-delta row 2) - not a new capability, just the SELECT half that was
-- missing for the UPDATE half to actually function under RLS. ADR 0029 is
-- being re-filed (SS3) to describe this two-policy shape explicitly; no new
-- ADR number is opened for this fix since it is the same accepted decision,
-- corrected to actually work.
-- ---------------------------------------------------------------------
DROP POLICY lease_owner_renew ON instance_lease_state;

CREATE POLICY lease_owner_renew_update ON instance_lease_state
  FOR UPDATE TO wp_app
  USING (owner_worker_id = nullif(current_setting('app.worker_id', true), ''))
  WITH CHECK (owner_worker_id = nullif(current_setting('app.worker_id', true), ''));

CREATE POLICY lease_owner_renew_select ON instance_lease_state
  FOR SELECT TO wp_app
  USING (owner_worker_id = nullif(current_setting('app.worker_id', true), ''));

-- ---------------------------------------------------------------------
-- Defensive hardening (reviewer suggestion 10, bundled into this same
-- migration since both touch this table's definer function): clamp
-- `wp_lease_scan_unowned`'s inputs so a caller bug can never turn the
-- discovery sweep into an unbounded scan. Identical body to 0018's
-- version except:
--   - `LIMIT max_rows` -> `LIMIT LEAST(GREATEST(max_rows, 0), 500)`: a
--     negative max_rows can no longer mean "unlimited" (Postgres treats a
--     negative LIMIT as an error already, but a caller bug passing a huge
--     positive number could still scan/return an unbounded number of rows -
--     500 is a generous ceiling well above any single discovery-sweep
--     tick's real batch size), and a negative input is floored to 0 rather
--     than erroring the whole statement.
--   - `stale_ms / 1000.0` -> `GREATEST(stale_ms, 0) / 1000.0`: a negative
--     stale_ms would otherwise shift the staleness cutoff into the future
--     (`now() - make_interval(secs => negative)` = `now() + interval`),
--     which would make every lease "stale" regardless of real liveness -
--     flooring at 0 makes a negative input behave like "everything is
--     eligible right now" at worst, never "shift the window forward".
--
-- CREATE OR REPLACE preserves the function's OID/dependents, but its
-- owner/search_path/grants are re-asserted explicitly below anyway
-- (defensive - matches this migration's own posture, even though REPLACE
-- does not actually reset any of the three).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wp_lease_scan_unowned(stale_ms bigint, max_rows int)
RETURNS TABLE (instance_id uuid, client_id uuid)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT i.id, i.client_id
    FROM public.whatsapp_instances i
    LEFT JOIN public.instance_lease_state ls
      ON ls.instance_id = i.id AND ls.client_id = i.client_id
   WHERE i.desired_state = 'online'
     AND i.deleted_at IS NULL
     AND i.link_state IN ('linked', 'pairing')
     AND i.health_state <> 'logged_out'
     AND (ls.instance_id IS NULL
          OR ls.lease_seen_at IS NULL
          OR ls.lease_seen_at < now() - make_interval(secs => greatest(stale_ms, 0) / 1000.0))
   ORDER BY random()
   LIMIT least(greatest(max_rows, 0), 500)
$$;

ALTER FUNCTION public.wp_lease_scan_unowned(bigint, int) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_lease_scan_unowned(bigint, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_lease_scan_unowned(bigint, int) TO wp_scheduler;
