-- P14 Unit U6 (guard pipeline inside the claim transaction, phase step 7) -
-- migration 0039. Forward-only, additive-only. No column dropped, no type
-- changed, no data rewritten, no REVOKE anywhere in this file.
--
-- WHY: `modules/pacing/guards/pipeline.ts#evaluateGuards` and
-- `engine/queue/send-loop-guard-pipeline-wiring.ts` (dispose-job.sql,
-- defer-job.sql, the widened pacing/thresholds read) all run INSIDE
-- `claimAndReserve`'s own transaction (`send-loop-pacing-claim.ts`) - the
-- SAME `tenantDb.withTenant` call that already runs under `wp_scheduler`
-- (the production claim/reserve role, migrations 0007/0010/0012/0025/0032/
-- 0037). `wp_scheduler` held ZERO grant on `opt_outs` / `tenant_blocked_
-- words` / `instance_recipient_contacts` / `content_fingerprints` /
-- `content_fingerprint_recipients` / `recipient_send_buckets` (migration
-- 0036's own header explicitly deferred this: "the guard pipeline reads
-- them under wp_app in the claim transaction" - superseded by this unit's
-- actual wiring decision, which keeps the WHOLE claim+guard+reserve
-- evaluation on one connection/role for one atomic transaction, never a
-- second role hop mid-transaction). `pacing_profiles` already carries a
-- table-level `wp_scheduler` SELECT grant (migration 0030) - untouched.
--
-- COLUMN LISTS - every grant below DERIVED DIRECTLY FROM a statement this
-- unit's own code actually runs under `wp_scheduler`, NOT GUESSED (same
-- discipline as migrations 0012/0025/0032/0037):
--
--   opt_outs SELECT (client_id, phone_hash, restored_at, scope, scope_key)
--     - modules/pacing/optout/registry.ts#isOptedOut's own SELECT, the ONE
--       opt-out lookup evaluateOptOutGate calls. No INSERT/UPDATE: the
--       guard pipeline only ever READS opt_outs (recording/restoring an
--       opt-out is wp_app's own surface, unchanged).
--
--   tenant_blocked_words SELECT (client_id, word)
--     - modules/pacing/content/blocked-words.ts's own SELECT, verbatim.
--
--   instance_recipient_contacts
--     SELECT (client_id, instance_id, recipient_hash, first_inbound_at)
--     - modules/pacing/content/link-guard.ts's own SELECT, verbatim.
--
--   content_fingerprint_recipients
--     INSERT (client_id, local_date, fingerprint, recipient_hash, created_at)
--     - count-fingerprint-recipient.sql's `recipient_ins` CTE INSERT, every
--       column it lists. No SELECT/UPDATE/DELETE: this table is written
--       once per (fingerprint, recipient) and never read back by name
--       (the ON CONFLICT DO NOTHING target needs no separate SELECT grant
--       beyond the implicit unique-index check Postgres performs under the
--       INSERT privilege itself).
--
--   content_fingerprints
--     INSERT (client_id, local_date, fingerprint, recipient_count),
--     UPDATE (recipient_count),
--     SELECT (recipient_count, ack_at)
--     - count-fingerprint-recipient.sql's `upserted` CTE: the INSERT column
--       list; the ON CONFLICT DO UPDATE SET recipient_count = ... self-
--       reference (`content_fingerprints.recipient_count` on the right-hand
--       side) needs SELECT on that column in addition to UPDATE; the final
--       RETURNING recipient_count, ack_at needs SELECT on both. `ack_by` is
--       never read or written by this unit's own statements - not granted.
--
--   recipient_send_buckets SELECT (client_id, phone_hash, hour_bucket, count)
--     - recipient-frequency-window.sql's own SELECT list, verbatim (the
--       WHERE predicates client_id/phone_hash/hour_bucket plus the
--       projected hour_bucket/count).
--
--   message_jobs UPDATE (pacing_deny_reason, pacing_deferrals)
--     - defer-job.sql's SET list - the ONE genuinely new message_jobs
--       write this unit needs. Every other column defer-job.sql/
--       dispose-job.sql touch (status, next_attempt_at, cancel_reason,
--       last_error_class, terminal_at, failed_at, lease_owner, lease_id,
--       owner_fence, leased_at, lease_expires_at, pacing_reserved_at,
--       updated_at, plus id/client_id/lease_id for the WHERE/RETURNING) is
--       already granted by migrations 0012/0025/0032/0037 - verified
--       against each of those migrations' own GRANT statements before
--       writing this file, not assumed. `pacing_deny_reason`/
--       `pacing_deferrals` were the two columns the pre-U6 inline
--       `writeDenialToJob` UPDATE already wrote (P13) but no migration had
--       ever actually granted to `wp_scheduler` - a real gap this unit
--       closes (the RLS-tagged claim test never exercised the pacing-deny
--       write path under the real role, only under the dev pool's own
--       BYPASSRLS superuser connection, which stayed silently correct
--       regardless of grants).
GRANT SELECT (client_id, phone_hash, restored_at, scope, scope_key)
  ON opt_outs TO wp_scheduler;

GRANT SELECT (client_id, word) ON tenant_blocked_words TO wp_scheduler;

GRANT SELECT (client_id, instance_id, recipient_hash, first_inbound_at)
  ON instance_recipient_contacts TO wp_scheduler;

GRANT INSERT (client_id, local_date, fingerprint, recipient_hash, created_at)
  ON content_fingerprint_recipients TO wp_scheduler;

GRANT INSERT (client_id, local_date, fingerprint, recipient_count)
  ON content_fingerprints TO wp_scheduler;
GRANT UPDATE (recipient_count) ON content_fingerprints TO wp_scheduler;
GRANT SELECT (recipient_count, ack_at) ON content_fingerprints TO wp_scheduler;

GRANT SELECT (client_id, phone_hash, hour_bucket, count)
  ON recipient_send_buckets TO wp_scheduler;

GRANT UPDATE (pacing_deny_reason, pacing_deferrals) ON message_jobs TO wp_scheduler;
