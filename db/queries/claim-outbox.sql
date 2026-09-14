-- claim-outbox.sql (P15 U4, step 5) - the relay's cross-tenant drain claim.
-- Executes as wp_relay (NOLOGIN, BYPASSRLS - migration 0041). Safe with N
-- concurrent relay processes: `FOR UPDATE SKIP LOCKED` means two relay
-- processes ticking at once each claim a disjoint subset of unpublished
-- rows, never the same row twice (proof:
-- `two_relay_processes_publish_each_event_exactly_once` in
-- `roles/relay.integration.test.ts`).
--
-- This statement CLAIMS ONLY - it does not itself set published_at (that
-- happens in a SEPARATE statement, `mark-outbox-published.sql`-shaped
-- UPDATEs the caller issues per coalesced winner/loser after the SSE batch
-- frame is actually published and the webhook rows are fanned to the
-- dispatcher's own durable state) - a crash between this SELECT and the
-- caller's mark-published UPDATE simply leaves the row unpublished for the
-- next tick to reclaim (never lost, never double-marked - see
-- `a_crash_between_dispatch_and_mark_republishes_and_the_receiver_dedupes`).
--
-- ORDER BY id ASC: oldest-first, same "no starvation" discipline as every
-- other claim statement in this schema - a 500-row LIMIT means backlog is
-- drained in commit order, not an arbitrary scan order.
--
-- Bounded at 500 rows/tick (ADR 0010 / phase task: "Tick 500 ms; claim ...
-- LIMIT 500").

-- name: claim-outbox
SELECT id, client_id, instance_id, event_type, entity_id, payload,
       coalesce_key, fanout, attempts, created_at
  FROM outbox_events
 WHERE published_at IS NULL
 ORDER BY id
 LIMIT $limit
   FOR UPDATE SKIP LOCKED;
