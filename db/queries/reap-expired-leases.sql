-- reap-expired-leases.sql (P12 Unit U2, step 3) - the cross-tenant
-- lease-expiry sweep (blueprint reaper): re-drives every `processing`
-- message_jobs row whose lease expired more than the grace period ago, one
-- pass across every tenant. Executes as wp_scheduler.
--
-- The full state machine (no-attempt/prepared -> requeue, dispatched ->
-- needs_reconcile, acked -> sent, failed -> requeue) lives ENTIRELY inside
-- the VOLATILE SECURITY DEFINER function `wp_reap_expired_leases` (migration
-- 0027) - this statement adds no additional filtering/ordering/projection of
-- its own, on purpose (same discipline as lease-scan-unowned.sql), so the
-- definer function's fixed projection and FOR UPDATE ... SKIP LOCKED batch
-- semantics are never silently reshaped by a wrapper predicate. Registered
-- in scripts/registries/cross-tenant-queries.ts under
-- "db/queries/reap-expired-leases.sql:reap-expired-leases".
--
-- Callers pass grace_seconds = TIMING.reaperGraceMs / 1000 and a bounded
-- limit (never unbounded - same discipline as reconcile-unresolved.sql's
-- max_rows).
--
-- Migration 0029 (P12 C1 review, CRITICAL finding 2): `error_class` and
-- `max_attempts` added to the projection - the definer function's RETURN
-- TABLE grew these two columns so the app-level reaper module can re-drive
-- a repaired `failed` attempt through the REAL `@wp/domain` classify()
-- decision (terminal / backoff-retry / pause-the-instance-on-a-restriction)
-- instead of the removed blind flat-5s SQL requeue. This statement still
-- adds no filtering/ordering/projection choice of its own beyond a 1:1
-- passthrough of the function's own columns (same discipline as before).

-- name: reap-expired-leases
SELECT client_id, instance_id, message_job_id, message_job_created_at,
       new_status, attempt_state, send_attempt_id, send_attempt_no,
       error_class, max_attempts
  FROM wp_reap_expired_leases($grace_seconds, $limit);
