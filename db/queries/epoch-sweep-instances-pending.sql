-- epoch-sweep-instances-pending.sql (P23 Unit U6, step 7) - the periodic
-- reconciliation sweep's cross-tenant discovery scan: every live (deleted_at
-- IS NULL) instance, keyset-paginated by id, bounded LIMIT - same
-- discover-cross-tenant-then-re-scope idiom as
-- contact-imports-pending-clients.sql/broadcast-campaigns-pending.sql. Every
-- per-instance sweep write is a SEPARATE tenantDb.withTenant transaction
-- (epoch-sweep.ts#runEpochStrandingSweep), never this scan again - an
-- instance with no stranded rows simply moves 0 rows on its own sweep call,
-- so this scan needs no join to message_jobs at all (which would require a
-- new SECURITY DEFINER function - out of this unit's scope; the belt-and-
-- braces cost is one cheap, index-scoped UPDATE per live instance per tick,
-- never an unbounded cross-tenant message_jobs read).

-- name: epoch-sweep-instances-pending
SELECT id, client_id, session_epoch
  FROM whatsapp_instances
 WHERE deleted_at IS NULL AND id > $after_id
 ORDER BY id
 LIMIT $limit;
