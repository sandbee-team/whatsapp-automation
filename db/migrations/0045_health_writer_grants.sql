-- P16 follow-up (Unit A2) - migration 0045.
-- Forward-only, additive-only grants migration closing the gap Unit C
-- flagged in `apply-band.ts` and `hard-signal-pause.ts`'s own module docs:
-- the health evaluator / fast-lane write paths (`HealthEvaluator.ts`,
-- `apply-band.ts`, `hard-signal-pause.ts`, `fast-lane.ts`) all run inside
-- `roles/session-worker.ts`'s send-loop and connection-update wiring
-- (`engine/queue/send-loop-worker-wiring.ts` line ~105,
-- `engine/session/runner-connection-update.ts`), both bound to the SAME
-- `tenantDb = createTenantDb(pool)` the role builds from `DATABASE_URL`
-- (`app/backend/src/roles/session-worker.ts` lines 67-73, 142-143, 173) -
-- no `SET LOCAL ROLE` anywhere in that call chain. Per the established
-- precedent for this exact cron/evaluator code-path class (migration 0034's
-- own header, `wp_warmup_apply_tier_change`: "every production caller of
-- that path is the cron evaluator, running as wp_scheduler"), production's
-- login role for this process is a member of `wp_scheduler`, and that is
-- the role this migration grants. No REVOKE anywhere in this file; every
-- existing grant (migrations 0025, 0030, 0044) is left completely intact.
--
-- COLUMN/TABLE LISTS ARE DERIVED DIRECTLY FROM THE THREE MODULES NAMED IN
-- THE GAP REPORT, NOT GUESSED:
--
--   whatsapp_instances.user_action_reason (UPDATE) -
--     `hard-signal-pause.ts#applyHardSignalPause`'s UPDATE sets
--     `user_action_reason = 'RESTRICTION_SIGNAL'` in the same statement as
--     the already-granted health_state/pause_reason/paused_at/
--     needs_user_action (migration 0025) - the one column that migration
--     omitted because no P16 writer existed yet at the time.
--
--   whatsapp_instances.pause_reason (SELECT) -
--     `hard-signal-pause.ts#applyHardSignalPause`'s own UPDATE statement
--     reads `pause_reason` back in its WHERE clause (`... OR pause_reason
--     IS DISTINCT FROM $1::pause_reason` - the idempotent-no-op guard, "already
--     paused for this exact reason", module doc). Postgres requires SELECT
--     privilege on any column read anywhere in an UPDATE's WHERE clause,
--     independent of the UPDATE grant on that same column - migration 0025
--     only ever granted UPDATE on pause_reason, never SELECT, because its
--     own writer (`result.ts`/`result-pause.ts`) never re-reads it in a
--     WHERE clause the way this new writer does. LIVE-DISCOVERED via
--     `wp-scheduler-health-writer-role.test.ts` (`permission denied for
--     table whatsapp_instances` on this exact statement before this line was
--     added) - not a speculative addition.
--
--   whatsapp_instances.updated_at (UPDATE) -
--     `hard-signal-pause.ts#applyHardSignalPause`'s UPDATE also sets
--     `updated_at = now()` in the same SET list. Migration 0025 granted
--     UPDATE on `whatsapp_instances` for the four PAUSE_INSTANCE columns
--     only (health_state, pause_reason, paused_at, needs_user_action) -
--     `result.ts`'s own pause write never touched `updated_at`, so no prior
--     migration ever granted it. ALSO LIVE-DISCOVERED via
--     `wp-scheduler-health-writer-role.test.ts` (binary-searched the exact
--     failing SET-list column against a raw client after the pause_reason
--     fix above still left the full statement denied) - not speculative.
--
--   audit_logs (INSERT) -
--     `hard-signal-pause.ts#applyHardSignalPause` inserts an
--     'instance.paused' row; `config-service-warmup-write.ts#
--     insertConfigAuditAndEvent` (called from `apply-band.ts` via
--     `updatePacingConfig({kind:'health_band'})`) inserts a
--     'pacing.config.change' row. Full-row INSERT, matching every existing
--     audit_logs INSERT grant in this schema (migrations 0013 wp_app,
--     0034 wp_warmup, 0041/0042 wp_relay - no column-level INSERT
--     precedent exists for this table).
--
--   outbox_events (INSERT) -
--     `hard-signal-pause.ts#applyHardSignalPause` and `apply-band.ts#
--     applyBandChange` both call `modules/events/emit.ts#emit(tx, ...)` on
--     the caller's own `tx`, which INSERTs one outbox_events row (plus a
--     same-transaction `pg_notify`, which needs no grant). Full-row INSERT,
--     matching the existing wp_app INSERT grant (migration 0041) - no
--     column-level INSERT precedent exists for this table either.
--
--   instance_pacing_state (UPDATE) -
--     `HealthEvaluator.ts#writeBookkeeping` (every evaluator tick, changed
--     or not) writes last_evidence/health_score/health_band/
--     health_band_since/eval_due_at/updated_at.
--     `hard-signal-pause.ts#applyHardSignalPause` writes
--     last_hard_signal_at.
--     `config-service-warmup-write.ts#updateEffRow` (the shared non-
--     warmup-tier `eff_*` recompute `apply-band.ts`'s `applyBandChange` and
--     `fast-lane.ts`'s `onSendOutcome` both route through via
--     `updatePacingConfig({kind:'health_band'})`) writes eff_daily_cap/
--     eff_hourly_cap/eff_new_conv_cap/eff_gap_min_ms/eff_gap_max_ms/
--     eff_cold_ratio_max/eff_cold_ratio_floor/eff_window_start_local/
--     eff_window_end_local/eff_group_daily_cap/config_version/updated_at/
--     health_band/health_band_since (COALESCE reads its own current value
--     in-statement for the two window columns and health_band, which is
--     covered by wp_scheduler's existing table-level SELECT, migration
--     0030 - no new SELECT needed).
--     Union of all three write sets, deduplicated (health_band/
--     health_band_since/updated_at appear in more than one caller,
--     eval_due_at only in HealthEvaluator's own bookkeeping, config_version
--     only in updateEffRow, last_evidence/health_score only in
--     HealthEvaluator, last_hard_signal_at only in hard-signal-pause.ts).
--     This migration's own doc note on 0030 ("only wp_app may rewrite
--     eff_*") and 0044 ("only wp_app rewrites this table") are narrowed
--     from "only" to "wp_app and now wp_scheduler" by this grant, matching
--     P16's actual, shipped write paths - not a speculative widening (see
--     0044/apply-band.ts/hard-signal-pause.ts's own "GRANT GAP (reported)"
--     notes, which this migration resolves).
--     eval_tier is DELIBERATELY NOT added to the UPDATE list: no writer
--     named in the gap report sets it (`HealthEvaluator.ts`'s own module
--     doc: "this tick ... leaves eval_tier UNCHANGED" - Unit E, out of
--     scope, owns that column's write).
--
-- ALREADY-PRESENT, NOT RE-GRANTED (verified against 0030/0044 above,
-- listed per the dispatch's instruction to state these explicitly):
--   - pacing_events SELECT, INSERT to wp_scheduler - migration 0030. Covers
--     `apply-band.ts`/`config-service-warmup-write.ts`'s BAND_CHANGE/
--     CONFIG_CHANGE INSERT, `hard-signal-pause.ts`'s hard_signal_pause
--     INSERT, and `HealthEvaluator.ts#writeBandChangeSuppressed`'s
--     BAND_CHANGE_SUPPRESSED INSERT (migration 0044 already widened the
--     CHECK constraint for that kind).
--   - instance_health_samples SELECT, INSERT to wp_scheduler - migration
--     0044. Covers `HealthEvaluator.ts#writeHealthSample` and
--     `apply-band.ts#applyBandChange`'s own sample INSERT.
--   - instance_pacing_state table-level SELECT to wp_scheduler - migration
--     0030 (plus the column-scoped SELECT from migration 0044) - covers
--     every read this migration's UPDATE statements themselves rely on
--     in-statement (COALESCE reads, health_band re-read), so no companion
--     SELECT grant is added here.
--   - whatsapp_instances UPDATE (health_state, pause_reason, paused_at,
--     needs_user_action) to wp_scheduler - migration 0025 - the read side
--     `HealthEvaluator.ts#readInstanceRow`/`fast-lane.ts` need
--     (health_state, created_at) is already covered by wp_scheduler's
--     existing table-level SELECT grant (migration 0010). `pause_reason`
--     itself was NOT already covered for SELECT - see item 1 below.

-- ---------------------------------------------------------------------
-- 1. whatsapp_instances - the missing pause-write column, plus the
--    pause_reason SELECT the same writer's own WHERE clause needs
--    (live-discovered - see header).
-- ---------------------------------------------------------------------
GRANT UPDATE (user_action_reason, updated_at) ON whatsapp_instances TO wp_scheduler;
GRANT SELECT (pause_reason) ON whatsapp_instances TO wp_scheduler;

-- ---------------------------------------------------------------------
-- 2. audit_logs - full-row INSERT, matching every existing precedent.
-- ---------------------------------------------------------------------
GRANT INSERT ON audit_logs TO wp_scheduler;

-- ---------------------------------------------------------------------
-- 3. outbox_events - full-row INSERT, matching the existing wp_app grant.
-- ---------------------------------------------------------------------
GRANT INSERT ON outbox_events TO wp_scheduler;

-- ---------------------------------------------------------------------
-- 4. instance_pacing_state - the union of HealthEvaluator.ts's bookkeeping
--    write, hard-signal-pause.ts's last_hard_signal_at write, and
--    config-service-warmup-write.ts's shared eff_* recompute (see header
--    for the full derivation).
-- ---------------------------------------------------------------------
GRANT UPDATE (
  last_evidence,
  health_score,
  health_band,
  health_band_since,
  eval_due_at,
  last_hard_signal_at,
  eff_daily_cap,
  eff_hourly_cap,
  eff_new_conv_cap,
  eff_gap_min_ms,
  eff_gap_max_ms,
  eff_cold_ratio_max,
  eff_cold_ratio_floor,
  eff_window_start_local,
  eff_window_end_local,
  eff_group_daily_cap,
  config_version,
  updated_at
) ON instance_pacing_state TO wp_scheduler;
