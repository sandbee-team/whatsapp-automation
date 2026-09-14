-- session-lease-is-valid.sql (P07 FIX-A C2-F1) - read-only fence/owner
-- validity probe used ONLY by `store-purge.ts`'s idempotent-purge decision:
-- after a zero-row purge delete pair, this distinguishes a GENUINE stale
-- fence (this caller's fence/owner no longer matches the live lease - a
-- real `FenceConflictError`) from a BENIGN replay of an already-applied
-- purge (the fence/owner still checks out; both durable deletes found
-- nothing only because a PRIOR purge already removed the rows). Same
-- predicate shape as every write statement's lease-fence EXISTS subquery
-- (tenant + fence + owner_worker_id), just read-only and boolean-shaped.

-- name: session-lease-is-valid
SELECT EXISTS (
  SELECT 1 FROM instance_lease_state ls
   WHERE ls.instance_id = $instance_id
     AND ls.client_id = $client_id
     AND ls.current_fence = $fence
     AND ls.owner_worker_id = $worker_id
) AS is_valid;
