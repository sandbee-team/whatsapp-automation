-- P14 Unit U4b - migration 0038.
-- Forward-only, additive-only. Widens pacing_events.kind's CHECK constraint
-- to also allow 'SYSTEM_SEND'. No column added/dropped/retyped, no data
-- rewritten, no grant touched.
--
-- WHY: modules/pacing/internal/system-send.ts (P14 Unit U4, step 5) writes a
-- pacing_events row for every exempt opt-out-confirmation send. Migration
-- 0030's original kind list (WARMUP_ADVANCE, WARMUP_ROLLBACK, BAND_CHANGE,
-- CONFIG_CHANGE, hard_signal_pause) has no entry for an exempt system send,
-- so the code was writing kind='CONFIG_CHANGE' - semantically wrong (this is
-- not a pacing config change) and it pollutes the stream P16's health/band
-- rate-limit logic will later derive from pacing_events. This migration adds
-- the missing 'SYSTEM_SEND' kind; the companion code change (this same unit)
-- flips system-send.ts to write it instead of 'CONFIG_CHANGE'.
--
-- SHAPE: the constraint is inline/unnamed in migration 0030's CREATE TABLE,
-- so Postgres auto-named it 'pacing_events_kind_check' (confirmed against
-- db/schema/pacing-events.ts's drizzle mirror, which already declares that
-- exact name explicitly). DROP the existing constraint by that name and
-- ADD CONSTRAINT back with the widened IN-list - CHECK constraints have no
-- ALTER-in-place form in Postgres, so drop+add is the only additive path
-- (same idiom as prior kind-list-shaped CHECK changes in this schema).
ALTER TABLE pacing_events DROP CONSTRAINT pacing_events_kind_check;

ALTER TABLE pacing_events ADD CONSTRAINT pacing_events_kind_check
  CHECK (kind IN (
    'WARMUP_ADVANCE', 'WARMUP_ROLLBACK', 'BAND_CHANGE', 'CONFIG_CHANGE',
    'hard_signal_pause', 'SYSTEM_SEND'
  ));
