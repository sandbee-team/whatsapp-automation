-- health-due.sql (P16 Unit E, step 9; WARNING 3 fix, P16 fix round) - the
-- health evaluator's own bounded, cross-tenant due-scan: every instance
-- whose `eval_due_at` has passed, oldest-due-first, capped at 200 rows per
-- tick (ADR 0018 §4 / scope-delta row 4-5: NO singleton loop may be
-- O(active instances) - this is an O(due), LIMIT-ed scan, same class as
-- `discover-instances.sql`/`lease-scan-unowned.sql`/
-- `reap-expired-leases.sql`).
--
-- CLAIM-BY-CONDITIONAL-UPDATE (WARNING 3 fix): with N session-worker
-- replicas each running this same timer, a bare SELECT would let every
-- replica read and evaluate the SAME due rows on the same tick - duplicate
-- samples, a double-spent improvement budget (bands.ts's own 1/6h, 2/24h
-- anti-flap caps), and lost EWMA updates (score.ts's smoothing folds the
-- SAME prior twice instead of once). This statement now CLAIMS the rows it
-- returns, atomically, by pushing `eval_due_at` 60 seconds into the future
-- for exactly the rows the inner `FOR UPDATE SKIP LOCKED` selects - the same
-- claim-by-conditional-write idiom as every other exactly-one-worker claim
-- in this schema (queue-engineering skill: "claim = single atomic
-- conditional write"). A concurrent replica's own `FOR UPDATE SKIP LOCKED`
-- subselect simply skips whichever rows this statement has already locked,
-- so two replicas never return the same instance_id on the same tick. The
-- 60s claim window matches tier 1's own cadence (eval-tier-ladder.ts) - a
-- row whose evaluation crashes before writeBookkeeping runs simply becomes
-- due again after 60s, never permanently stuck (same "crashed evaluation
-- retried on a later tick" fail-safe evaluator-loop.ts's own module doc
-- documents for the per-row try/catch).
--
-- Cross-tenant by nature (scans + writes across every client_id in one
-- statement) - registered in scripts/registries/cross-tenant-queries.ts
-- under this file's own key, role wp_scheduler (same login role as every
-- other P16 health write path, migration 0045's header; the claim UPDATE
-- itself needs `UPDATE (eval_due_at)` on `instance_pacing_state`, already
-- granted to wp_scheduler by migration 0045). Runs on a bare pool/query
-- executor - `instance_pacing_state` carries no per-row secret, and the
-- per-instance evaluation this scan feeds runs each row through
-- `tenantDb.withTenant(clientId, ...)` immediately after, same idiom as
-- `warmup-evaluator.ts#runOnePacingEvaluatorSweep`.
--
-- $1 = max rows (bounded batch size; caller-supplied, defaults to 200 per
--      the task's own LIMIT literal). This statement's outer shape is an
--      UPDATE ... WHERE instance_id IN (SELECT ...) - a BATCH write, never
--      exempt from check-scheduler-queries.ts's guard as a "point write"
--      (scheduler-queries-lib.ts#isInherentlySingleRow, P16 fix round Fix 2:
--      an IN (SELECT ...) predicate is never treated as inherently
--      single-row). It passes instead because `hasLimitClause`'s
--      string-level check finds the LIMIT keyword inside the inner
--      subselect - the keyword need not sit at the outer statement's top
--      level, but it must actually be present; deleting it now correctly
--      turns the guard red.
--
-- Ordered by eval_due_at ASC so the most-overdue instances are always
-- served first when the due set exceeds the per-tick cap.

-- name: health-due
UPDATE instance_pacing_state
   SET eval_due_at = now() + interval '60 seconds'
 WHERE instance_id IN (
   SELECT instance_id
     FROM instance_pacing_state
    WHERE eval_due_at <= now()
    ORDER BY eval_due_at ASC
    LIMIT $max_rows
      FOR UPDATE SKIP LOCKED
 )
RETURNING instance_id, client_id;
