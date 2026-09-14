-- P16 Unit A - bounded 30-day retention sweep for instance_health_samples
-- (migration 0044). Mirrors app/backend/src/modules/events/cleanup.ts's
-- runOutboxCleanup exactly: Postgres DELETE has no LIMIT clause, so this
-- uses the `WHERE id IN (SELECT ... LIMIT $2)` idiom to keep the sweep
-- bounded per tick - never an unbounded cross-tenant statement.
--
-- $1 = retention interval in milliseconds (30 days = 2592000000 by default,
--      caller-supplied so the cadence stays a code-level constant, not a
--      hardcoded literal in this file).
-- $2 = per-tick delete cap (bounded batch size; caller-supplied).
--
-- WIRING (P16 Unit E, step 10 - closes Unit A's own reported gap; CORRECTED
-- after gate review, migration 0046's own header): called by
-- app/backend/src/modules/pacing/health/retention.ts#runHealthSamplesCleanup,
-- invoked from the health-evaluator's own low-cadence retention timer
-- (session-worker-health-loop-wiring.ts, hourly +/- 5min jitter, a SEPARATE
-- timer from the 5s due-scan) under the SAME wp_scheduler login role as
-- every other P16 health write path (migration 0045's own header) - NOT
-- roles/relay.ts's wp_relay role (deliberately minimal, P15 grant narrowing;
-- wp_relay must never gain a fifth table). NOT called by the health-evaluator
-- SCAN sweep itself (explicit instruction, kept - the two sweeps have
-- unrelated cadences).
--
-- RETURNING id added (this unit) so the caller can report a deleted-row
-- count, matching runOutboxCleanup's own DELETE ... RETURNING id shape.
DELETE FROM instance_health_samples
 WHERE id IN (
   SELECT id FROM instance_health_samples
    WHERE created_at < now() - ($1 || ' milliseconds')::interval
    ORDER BY id
    LIMIT $2
 )
RETURNING id;
