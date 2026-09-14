-- purge-terminal-import-objects.sql (P20 C1 M2) - the ROW-DRIVEN half of the
-- import retention purge's object cleanup: selects candidate `contact_imports`
-- rows to delete their uploaded CSV object for, gated on `status IN ('done',
-- 'failed', 'cancelled')` so a still-`importing`/`uploaded` import's source
-- object is NEVER reclaimed regardless of its `created_at` age (a purge must
-- never delete the source of a still-running import). Bounded by $limit
-- (ADR 0018 S4). `retention-purge.ts` calls `objectStore.head`+`delete` per
-- returned `storage_key` - an already-gone object is the idempotency marker
-- (no column needed), consistent with the module's existing convention.

-- name: purge-terminal-import-objects
SELECT id, storage_key
  FROM contact_imports
 WHERE client_id = $client_id
   AND created_at < $cutoff
   AND status IN ('done', 'failed', 'cancelled')
 ORDER BY created_at ASC
 LIMIT $limit;
