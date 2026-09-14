-- P17 fix-round - migration 0050.
-- Forward-only, additive/corrective only: drops one partial index created in
-- 0049 and replaces it with a client_id-leading equivalent. No table
-- created/dropped, no column added/dropped/retyped, no existing grant
-- narrowed.
--
-- CONTEXT: C1 reviewer WARNING on migration 0049
-- (db/migrations/0049_notification_dispatch_support.sql:129) -
-- `message_jobs_queued_created_idx (instance_id, created_at) WHERE
-- status = 'queued'` omits client_id, so it cannot serve
-- `db/queries/instance-card-oldest-queued.sql`'s probe
-- (`client_id = $1 AND instance_id = $2 AND status = 'queued'`) as an
-- index-only scan: instance_id alone is not the query's full equality
-- predicate, so Postgres must re-check the heap row's client_id for every
-- candidate the index yields, defeating the point of an index-only path.
-- Every other message_jobs index declared in 0007 leads with client_id
-- (message_jobs_claim_idx, message_jobs_review_idx, message_jobs_recent_idx,
-- message_jobs_recipient_recent_idx) - 0049's queued-probe index was the one
-- outlier, not a deliberate exception (unlike message_jobs_lease_expiry_idx,
-- which is INTENTIONALLY global for the cross-tenant lease sweep - see
-- db/src/isolation/canonical-authority-keys.ts's own `lease_expires_at`
-- entry). This migration corrects that: drop the instance_id-leading index
-- and recreate it client_id-leading, matching the probe's actual equality
-- predicate exactly, so the planner can answer it as a pure forward Index
-- Only Scan + Limit 1 with no heap re-check at all.
--
-- Declared on the parent (message_jobs is RANGE-partitioned by created_at,
-- migration 0007) so DROP/CREATE both recurse onto every existing partition
-- and the new shape is inherited by every partition created afterwards -
-- same declaration style 0049 used.
DROP INDEX message_jobs_queued_created_idx;

CREATE INDEX message_jobs_queued_probe_idx
  ON message_jobs (client_id, instance_id, created_at)
  WHERE status = 'queued';
