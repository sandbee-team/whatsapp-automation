-- P14 review-fix F1 (C1 reviewer, live-verified against dev DB) - migration
-- 0040. Forward-only, additive-only. No column dropped, no type changed, no
-- REVOKE anywhere in this file (the threshold-hardening section adds NOT
-- NULL + CHECK constraints after a corrective UPDATE, per the standing rule
-- that a destructive change to message_jobs/delivery_events needs explicit
-- user approval - this migration touches neither table destructively:
-- pacing_profiles is the only table ALTERed here, and every ALTER is
-- additive-safe once the backfill UPDATE runs first).
--
-- =======================================================================
-- PART 1 - CORRECTS A WRONG CLAIM IN MIGRATION 0039's OWN HEADER (never
-- edit 0039 itself; forward-only. This is the correction, stated here).
--
-- 0039's header says (verbatim): "the ON CONFLICT DO NOTHING target needs no
-- separate SELECT grant beyond the implicit unique-index check Postgres
-- performs under the INSERT privilege itself." THIS IS WRONG. Verified live
-- against the dev DB under `SET ROLE wp_scheduler` (see Part 4 below):
-- Postgres requires SELECT on every column referenced by an
-- `INSERT ... ON CONFLICT` arbiter/target, even for `DO NOTHING` - the
-- INSERT privilege alone does not cover the conflict-detection read. The
-- same requirement applies to `content_fingerprints`' `ON CONFLICT DO
-- UPDATE` arbiter columns, which 0039 also left unselected outside the
-- `recipient_count`/`ack_at` grant it already had.
--
-- CONSEQUENCE OF THE GAP: the P14 guard pipeline runs entirely inside
-- `claimAndReserve`'s own transaction under `wp_scheduler` (0039's own
-- framing, correct). Without these SELECT grants, EVERY claim that reaches
-- `count-fingerprint-recipient.sql` would throw a column-privilege error in
-- production - not a degraded path, a hard failure on every guarded claim.
--
-- COLUMN LISTS - DERIVED DIRECTLY FROM count-fingerprint-recipient.sql's own
-- statements (db/queries/count-fingerprint-recipient.sql), NOT GUESSED:
--
--   content_fingerprint_recipients
--     SELECT (client_id, local_date, fingerprint, recipient_hash)
--     - the `recipient_ins` CTE's `INSERT ... ON CONFLICT (client_id,
--       local_date, fingerprint, recipient_hash) DO NOTHING` - the four
--       arbiter columns, exactly the table's own PK.
--
--   content_fingerprints
--     SELECT (client_id, local_date, fingerprint)
--     - the `upserted` CTE's `INSERT ... ON CONFLICT (client_id, local_date,
--       fingerprint) DO UPDATE` - the three arbiter columns, exactly the
--       table's own PK. (recipient_count/ack_at were already granted SELECT
--       by 0039 for the RETURNING list and the `SET recipient_count =
--       content_fingerprints.recipient_count + ...` self-read - untouched,
--       not re-granted here.)
--
-- =======================================================================
-- PART 2 - THE SAME GAP CLASS FOR message_jobs' SELF-REFERENCING WRITES.
--
-- `defer-job.sql` sets `pacing_deferrals = pacing_deferrals + 1` (a
-- self-read on the right-hand side) and `dispose-job.sql` sets several
-- columns via `CASE WHEN ... THEN ... ELSE <column> END` (also a self-read
-- when the ELSE branch preserves the existing value: `last_error_class =
-- CASE ... ELSE last_error_class END`, `failed_at = CASE ... ELSE failed_at
-- END`). An UPDATE's SET-list self-reference needs SELECT on that column in
-- addition to UPDATE, exactly the same rule as an ON CONFLICT arbiter (both
-- are "Postgres must be able to READ the current row to write the new one").
-- 0039 granted UPDATE on `pacing_deny_reason, pacing_deferrals` but no
-- SELECT on `pacing_deferrals` for its own self-read, and no SELECT at all
-- on `last_error_class`/`failed_at`, which dispose-job.sql's CASE/ELSE
-- clauses read even though it never grants UPDATE on them from this
-- migration (dispose-job.sql's `last_error_class`/`failed_at` UPDATE
-- privilege was already granted by migration 0025 - only the SELECT half
-- for the CASE/ELSE self-read was missing).
--
--   message_jobs SELECT (pacing_deferrals, last_error_class, failed_at)
--     - defer-job.sql's `pacing_deferrals = pacing_deferrals + 1` self-read;
--       dispose-job.sql's `last_error_class = CASE ... ELSE
--       last_error_class END` and `failed_at = CASE ... ELSE failed_at END`
--       self-reads. `cancel_reason`'s ELSE branch reads `$reason`, not the
--       column, so no SELECT is added for it here.
--
-- =======================================================================
-- PART 3 - recipient_send_buckets: THE SAME UPSERT SELF-READ GAP, ON THE
-- SEND-WORKER'S OWN CONNECTION.
--
-- `app/backend/src/engine/queue/result.ts#resolveAck` runs
-- `INSERT INTO recipient_send_buckets (...) VALUES (...)
--  ON CONFLICT (client_id, phone_hash, hour_bucket)
--  DO UPDATE SET count = recipient_send_buckets.count + 1` inside
-- `deps.tenantDb.withTenant(...)` - the send-worker's own tenantDb, which
-- runs under `wp_scheduler` (same role/connection as the claim transaction;
-- `roles/session-worker.ts` boots one pool for the whole process, no role
-- hop between claim and result-write). Migration 0036 granted `wp_app`
-- SELECT/INSERT/UPDATE on this table but granted `wp_scheduler` NOTHING -
-- `resolveAck`'s own INSERT would throw on every acked send with a
-- recipient hash, and because `resolveAck` commits the job's `sent_at` in
-- the SAME transaction as the failing bucket upsert, that failure would
-- roll back the whole ack - the send genuinely happened at the provider,
-- but the job would stay `processing` forever and eventually get reaped and
-- RE-SENT: a duplicate-send loop, not merely a missed counter increment.
--
--   recipient_send_buckets
--     SELECT (client_id, phone_hash, hour_bucket, count),
--     INSERT (client_id, phone_hash, hour_bucket, count),
--     UPDATE (count)
--     - SELECT: the ON CONFLICT (client_id, phone_hash, hour_bucket) arbiter
--       (the table's own PK) plus the `recipient_send_buckets.count + 1`
--       self-read on the DO UPDATE's SET list - same two-part rule as Parts
--       1/2 above, both needs met by one grant naming all four columns
--       (arbiter three plus count).
--     - INSERT: the VALUES list's own four columns, verbatim.
--     - UPDATE: `count` only - the one column the DO UPDATE actually SETs.
GRANT SELECT (client_id, local_date, fingerprint, recipient_hash)
  ON content_fingerprint_recipients TO wp_scheduler;
GRANT SELECT (client_id, local_date, fingerprint)
  ON content_fingerprints TO wp_scheduler;
GRANT SELECT (pacing_deferrals, last_error_class, failed_at)
  ON message_jobs TO wp_scheduler;
GRANT SELECT (client_id, phone_hash, hour_bucket, count),
      INSERT (client_id, phone_hash, hour_bucket, count),
      UPDATE (count)
  ON recipient_send_buckets TO wp_scheduler;

-- =======================================================================
-- PART 4 (in this migration's file, verified live in a separate psql
-- session per this fix's own task instruction - see the outer report for
-- the transcript, not repeatable as DDL in this file): `SET ROLE
-- wp_scheduler` plus `SET app.client_id = '<uuid>'` reproduced all four
-- statements this migration's grants unblock - the fingerprint ON CONFLICT
-- insert, the defer `pacing_deferrals = pacing_deferrals + 1` UPDATE, the
-- dispose CASE UPDATE, and the recipient_send_buckets upsert - and confirmed
-- each one FAILED with a column-privilege error before this migration and
-- SUCCEEDED after.
--
-- =======================================================================
-- PART 5 - THRESHOLD HARDENING (reviewer finding 5, migration half). Every
-- system pacing profile's four dedupe/fan-out thresholds are made NOT NULL
-- with a CHECK floor, mirroring the structural-floor precedent migration
-- 0033 set for `instance_pacing_state.eff_*` (a TypeScript-only floor is not
-- a floor - core invariant 6 requires the DATABASE ROW itself to enforce
-- it, for every writer, not just whichever code path happens to validate
-- first). Canon values (safe-mode design SS3.4 + the `pacing_profiles` DDL
-- default, migration 0030's own CREATE TABLE comment - `per_recipient_24h`/
-- `per_recipient_7d` are documented there as the per-recipient rolling-
-- window caps the safe-mode design specifies): `per_recipient_24h = 3`,
-- `per_recipient_7d = 8`, `dup_fanout_warn = 150`, `dup_fanout_ack = 500`.
--
-- Backfill UPDATE runs BEFORE the NOT NULL/CHECK ALTERs (an ALTER ... SET
-- NOT NULL against a table that still has a NULL row fails outright; a
-- CHECK added via the default ADD CONSTRAINT form validates existing rows
-- immediately, same reason).
UPDATE pacing_profiles SET per_recipient_24h = 3 WHERE per_recipient_24h IS NULL;
UPDATE pacing_profiles SET per_recipient_7d = 8 WHERE per_recipient_7d IS NULL;
UPDATE pacing_profiles SET dup_fanout_warn = 150 WHERE dup_fanout_warn IS NULL;
UPDATE pacing_profiles SET dup_fanout_ack = 500 WHERE dup_fanout_ack IS NULL;

ALTER TABLE pacing_profiles
  ALTER COLUMN per_recipient_24h SET NOT NULL,
  ALTER COLUMN per_recipient_7d SET NOT NULL,
  ALTER COLUMN dup_fanout_warn SET NOT NULL,
  ALTER COLUMN dup_fanout_ack SET NOT NULL,
  ADD CONSTRAINT pacing_profiles_per_recipient_24h_positive CHECK (per_recipient_24h > 0),
  ADD CONSTRAINT pacing_profiles_per_recipient_7d_positive CHECK (per_recipient_7d > 0),
  ADD CONSTRAINT pacing_profiles_dup_fanout_warn_positive CHECK (dup_fanout_warn > 0),
  ADD CONSTRAINT pacing_profiles_dup_fanout_ack_positive CHECK (dup_fanout_ack > 0),
  ADD CONSTRAINT pacing_profiles_dup_fanout_warn_lt_ack CHECK (dup_fanout_warn < dup_fanout_ack);

-- =======================================================================
-- PART 6 - SEED CORRECTION (reviewer finding 13). Migration 0031 seeded
-- `per_recipient_24h = 1` on ALL THREE system profiles (`conservative`,
-- `safe_default`, `steady`) - verified by reading 0031's own INSERT VALUES
-- list before writing this migration. Canon (safe-mode design SS3.4, and
-- `pacing_profiles`' own DDL comment in migration 0030) is 3 per rolling
-- 24h for the DEFAULT profile. `safe_default` IS the platform default
-- (`instance_pacing_state.profile_key DEFAULT 'safe_default'`, migration
-- 0030) - seeding it at 1 directly contradicts the documented default and
-- is corrected here to 3. `steady` mirrors `safe_default`'s volume envelope
-- exactly everywhere else it is seeded (0031's own header: "steady's
-- daily/hourly/new-conv caps and ceiling are IDENTICAL to safe_default's...
-- a steadier send cadence within the same volume envelope, not a higher
-- one") - `per_recipient_24h = 1` on `steady` was the SAME contradiction as
-- `safe_default`'s, not a deliberate tightening, so `steady` is corrected to
-- 3 as well.
--
-- `conservative` is DELIBERATELY left at 1 - it is documented (0031's own
-- header) as strictly tighter than `safe_default` on every other dimension
-- (lower caps, longer gaps, lower cold_ratio_max, 600 vs 1,000 ceiling), so
-- a tighter per-recipient-24h cap is consistent with its own stated design
-- intent, not a bug this fix is chartered to touch. Tightening is allowed;
-- the finding is specifically that `safe_default` contradicts canon, not
-- that every profile must share one number.
UPDATE pacing_profiles SET per_recipient_24h = 3 WHERE key IN ('safe_default', 'steady');
