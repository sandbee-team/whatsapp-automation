-- P03 Unit D (db-queue-and-claim), step 8, carried P02 item - narrows
-- wp_scheduler's grants to exactly what the canonical claim
-- (db/queries/claim-jobs.sql) reads/writes. Migration 0007 left wp_scheduler
-- with TABLE-LEVEL SELECT+UPDATE on message_jobs, flagged there as deferred
-- to "P03 Unit B, which owns [claim-jobs.sql] and therefore knows the real
-- column list" - this migration is that follow-up. Forward-only, additive/
-- narrowing only: no table is dropped, no other role's grants change.
--
-- COLUMN LISTS ARE DERIVED DIRECTLY FROM claim-jobs.sql, NOT GUESSED:
--   UPDATE SET list  - the 9 columns claim-jobs.sql's SET clause writes,
--                       verbatim.
--   message_jobs SELECT - every message_jobs column claim-jobs.sql reads,
--                       across its WHERE clauses, its join predicates
--                       (i.session_epoch = j.session_epoch,
--                       cp.id = j.campaign_id), the UPDATE's own
--                       WHERE/FROM (j.id, j.created_at, j.status), and its
--                       RETURNING list.
--   clients SELECT      - c.id (join) and c.status (WHERE).
--   wallet_accounts SELECT - w.client_id (join), w.state, w.balance_minor,
--                       w.max_rate_minor (WHERE).
--
-- DECISION - message_jobs SELECT is narrowed to columns, not left
-- table-level: this migration already narrows message_jobs UPDATE to
-- columns for the same role in the same statement group, and migration
-- 0010 already set the precedent for wp_scheduler (narrow SELECT on
-- whatsapp_instances) - leaving message_jobs SELECT at table-level here
-- would be an inconsistent half-measure that exposes columns the claim
-- never reads (`cancel_reason`, `last_error_class`, `content_fingerprint`,
-- `created_by_user_id`, etc.) to a role whose only caller is this one
-- statement.
--
-- WHATSAPP_INSTANCES - NOT altered here. Migration 0010 already granted
-- wp_scheduler exactly `SELECT (id, client_id, health_state, session_epoch,
-- deleted_at)` on whatsapp_instances - precisely the dispatch's target list
-- for this table - so there is nothing to narrow; re-issuing an identical
-- GRANT would be a no-op statement with no snapshot effect. Left as a
-- header note, not a statement, so the grants-snapshot diff for this
-- migration shows only real changes.
--
-- INSTANCE_LEASE_STATE / CAMPAIGNS - also NOT altered here, per the
-- dispatch: migration 0010 already grants wp_scheduler table-level
-- SELECT+INSERT+UPDATE on instance_lease_state (P06 owns fence-bump/lease-
-- sweep logic on this table and will need INSERT/UPDATE beyond what the
-- claim itself uses) and table-level SELECT on campaigns (the claim's own
-- LEFT JOIN needs only cp.id/cp.status/cp.client_id, all covered). Neither
-- table's existing grant is unmet by the claim's needs, so neither is
-- touched.
--
-- FUTURE WIDENING: later phases (P06 reaper/fence-sweep queries, the P0x
-- result-writer that records sent/failed) will need additional
-- message_jobs columns/statements (e.g. writing `sent_at`, `failed_at`,
-- `attempts`, `last_error_class`) - those are ADDITIVE grants in THEIR OWN
-- migrations when they land, never a reason to re-widen this one.

-- ---------------------------------------------------------------------
-- message_jobs: replace table-level SELECT+UPDATE (migration 0007) with the
-- claim's exact column sets.
-- ---------------------------------------------------------------------
REVOKE SELECT, UPDATE ON message_jobs FROM wp_scheduler;

GRANT SELECT (
  id, created_at, client_id, instance_id, session_epoch, campaign_id,
  status, priority_rank, next_attempt_at, scheduled_at, recipient_jid,
  payload, payload_kind, attempts, lease_id
) ON message_jobs TO wp_scheduler;

GRANT UPDATE (
  status, lease_owner, lease_id, owner_fence, leased_at, lease_expires_at,
  pacing_reserved_at, pacing_ledger_date, updated_at
) ON message_jobs TO wp_scheduler;

-- ---------------------------------------------------------------------
-- clients / wallet_accounts: migration 0005 left wp_scheduler with no
-- grant on either (its narrow-by-design posture at the time, before this
-- role had a real caller) - the claim is that caller now.
-- ---------------------------------------------------------------------
GRANT SELECT (id, status) ON clients TO wp_scheduler;

GRANT SELECT (client_id, state, balance_minor, max_rate_minor)
  ON wallet_accounts TO wp_scheduler;
