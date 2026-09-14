-- lease-mint-read-released.sql (P06 Unit U3, extended P06 Unit U5) - first
-- half of the fence-mint pair, always run in the SAME transaction as
-- lease-mint-fence.sql immediately after (see lease-state-repo.ts's
-- mintFence). Locks the instance's lease row (if any) for the duration of
-- the mint transaction so two concurrent mints for the same instance
-- serialise through Postgres row locking rather than racing the upsert in
-- lease-mint-fence.sql. Zero rows is the normal outcome for an instance
-- that has never been leased before - lease-mint-fence.sql's ON CONFLICT DO
-- UPDATE / DO INSERT covers both cases. Tenant-scoped (runs under
-- TenantDb.withTenant, role wp_app) - the tenant_isolation policy supplies
-- the client_id predicate implicitly, but $client_id is still bound
-- explicitly in the WHERE clause per core invariant 4 (every query filters
-- by client_id, not just the RLS policy).
--
-- U5 extension: also reads `owner_worker_id` (the PRE-mint owner, before
-- lease-mint-fence.sql overwrites it) so `mintFence` can report whether this
-- mint is a real takeover (a DIFFERENT worker previously held the lease) -
-- `wp_lease_takeovers_total` (lease-metrics.ts) increments only on that
-- case, never on a first-ever mint (no prior owner) or a worker re-minting
-- its own lease.

-- name: lease-mint-read-released
SELECT released_at, owner_worker_id
  FROM instance_lease_state
 WHERE instance_id = $instance_id
   AND client_id = $client_id
 FOR UPDATE;
