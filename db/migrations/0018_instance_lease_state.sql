-- P06 (session-lease-and-fence) - migration 0018.
-- ADDITIVE on the P03 (0010) `instance_lease_state` shell - ALTERs only,
-- never DROP/re-CREATE (0010's header names P06 as the owner of this
-- table's fence-bumping/lease-sweep logic). `whatsapp_instances` never
-- carried `current_fence`/`lease_seen_at` (0010 excluded them by design -
-- see schema-assertions.test.ts's `whatsapp_instances_no_longer_carries_a_
-- fence`), so there is nothing to drop there; its leftover `owner_worker_id`
-- column is P08's problem, left untouched here.

-- ---------------------------------------------------------------------
-- 1. Release bookkeeping: when a worker cleanly releases a lease (vs. being
--    reclaimed as stale), released_at records when.
-- ---------------------------------------------------------------------
ALTER TABLE instance_lease_state ADD COLUMN released_at timestamptz;

-- ---------------------------------------------------------------------
-- 2. Storage params: this table is renew-hot (every live worker touches its
--    own lease row on a tight tick) and narrow (few columns) - a lower
--    fillfactor leaves room for HOT updates, and more aggressive autovacuum
--    keeps the frequent UPDATE churn from bloating the table between
--    autovacuum runs.
-- ---------------------------------------------------------------------
ALTER TABLE instance_lease_state
  SET (fillfactor = 60, autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_cost_limit = 2000);

-- ---------------------------------------------------------------------
-- 3. ils_stale_idx - deliberately global (NOT client_id-leading): the
--    unowned-instance discovery sweep (wp_lease_scan_unowned below) scans
--    stale lease liveness across every tenant in one pass, same class as
--    message_jobs_lease_expiry_idx (migration 0007). Partial on
--    `owner_worker_id IS NOT NULL` - an unowned lease row (or no row at all,
--    handled by the LEFT JOIN in the scan) is not a "stale lease" to sweep.
--    Registered in CANONICAL_AUTHORITY_KEYS.instance_lease_state, NOT a
--    fourth SUITE_A_INDEX_EXEMPTIONS entry (ADR 0029 SS1 - that registry is
--    for UNIQUE-index authorities only; this index is non-unique).
-- ---------------------------------------------------------------------
CREATE INDEX ils_stale_idx ON instance_lease_state (lease_seen_at)
  WHERE owner_worker_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 4. Grants fixup (ADR 0029 SS3). The 0010 shell granted wp_scheduler
--    SELECT/INSERT/UPDATE; that was provisional for the claim-join shell
--    and is now replaced: wp_app (the worker-facing role, RLS-bound) owns
--    minting (INSERT, tenant-scoped) and renewing (UPDATE, column-narrowed
--    to the four lease-liveness columns - never client_id/instance_id) a
--    lease. wp_scheduler keeps SELECT only (it still reads current_fence
--    for the claim join in db/queries/claim-jobs.sql, ADR 0026) plus its
--    EXECUTE grant on the discovery-scan function below. wp_admin_app stays
--    SELECT-only (never gains a write grant here - ADR 0029 SS4, same
--    forbidden staff-side-takeover class as whatsapp_instances writes).
-- ---------------------------------------------------------------------
REVOKE INSERT, UPDATE ON instance_lease_state FROM wp_scheduler;

GRANT SELECT, INSERT ON instance_lease_state TO wp_app;
GRANT UPDATE (current_fence, owner_worker_id, lease_seen_at, released_at)
  ON instance_lease_state TO wp_app;

-- ---------------------------------------------------------------------
-- 5. Worker-scoped renew policy (ADR 0029 SS3). Permissive, OR-ed with the
--    existing `tenant_isolation` policy (untouched) - this policy alone
--    lets a worker's cross-tenant batched renew (one UPDATE statement
--    across every instance it currently owns, mandated by scope-delta row
--    2 / ADR 0018 SS4 at 1,000+ sessions) see and touch only rows it
--    already owns, keyed on the `app.worker_id` GUC the calling worker
--    process sets - never a blanket cross-tenant UPDATE. A row that fails
--    this predicate is filtered out the same way a fence mismatch would be
--    (fail-safe: indistinguishable from "someone else's lease" at the
--    caller).
-- ---------------------------------------------------------------------
CREATE POLICY lease_owner_renew ON instance_lease_state
  FOR UPDATE TO wp_app
  USING (owner_worker_id = nullif(current_setting('app.worker_id', true), ''))
  WITH CHECK (owner_worker_id = nullif(current_setting('app.worker_id', true), ''));

-- ---------------------------------------------------------------------
-- 6. wp_lease_scan_unowned - read-only discovery-scan definer function
--    (ADR 0029 SS2). Hardening conventions copied exactly from the 0005
--    section-4 boot-gate precedent as pinned in 0006, and from 0015's
--    wp_client_id_for_user: owned by wp_admin_app (BYPASSRLS - a
--    tenant-scoped `wp_migrator` owner would just re-inherit the "zero rows
--    with no app.client_id GUC set" problem this function exists to solve,
--    the same reasoning 0005/0015 already establish), pinned
--    `search_path = pg_catalog, public` (a mutable search_path on a
--    SECURITY DEFINER function is a privilege-escalation primitive per
--    0006), REVOKE ALL FROM PUBLIC, EXECUTE granted to wp_scheduler only
--    (the dispatch-loop role that runs the discovery sweep - not wp_app,
--    not wp_admin_app itself, which already bypasses RLS directly).
--
--    Read-only, projects exactly (instance_id, client_id) - no other
--    column of whatsapp_instances or instance_lease_state is exposed
--    through this function. The LEFT JOIN is deliberate: an online
--    instance with NO lease row yet (first-ever claim) must still be
--    discoverable, not hidden behind an INNER JOIN that would only ever
--    see instances that already have a lease row.
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_lease_scan_unowned(stale_ms bigint, max_rows int)
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
          OR ls.lease_seen_at < now() - make_interval(secs => stale_ms / 1000.0))
   ORDER BY random()
   LIMIT max_rows
$$;

ALTER FUNCTION public.wp_lease_scan_unowned(bigint, int) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_lease_scan_unowned(bigint, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_lease_scan_unowned(bigint, int) TO wp_scheduler;
