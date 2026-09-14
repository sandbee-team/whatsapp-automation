-- db/seeds/pacing-profiles.sql (P13 Unit U1) - reusable seed data for the
-- three system pacing profiles (`conservative`/`safe_default`/`steady`) and
-- the six-tier `safe_default` warm-up ladder plus its two sibling ladders.
-- Unlike `queue-explain-fixture.sql` (db/seeds/README.md: "dev/demo seed
-- data, never runs against prod"), this file's DATA is real platform
-- catalog content every environment needs (pacing_profiles/
-- pacing_warmup_tiers have no client_id - they are global catalogs, same
-- class as `plans`/`plan_limits`), not throwaway dev fixtures. It exists as
-- a standalone fixture entrypoint for tests/tooling that want to (re-)seed
-- catalog rows without re-running the full migration set.
--
-- `db/migrations/0031_pacing_seed.sql` DUPLICATES this file's statements
-- verbatim rather than `\i`-including it: the migration runner
-- (db/src/migrate.ts) reads migration files as raw bytes through a plain
-- `pg.Client` - `\i` is a psql meta-command, not SQL, and has no effect
-- (silently does nothing useful) run through `pg.Client#query`. Duplication
-- is therefore the only correct "reusable for both" shape here; keep the
-- two files in sync by hand if the ladder ever changes (forward-only - a
-- ladder correction is a NEW migration, never an edit to 0031).
--
-- Idempotent via `ON CONFLICT ... DO UPDATE` (not `DO NOTHING`): re-running
-- this seed after a deliberate ladder correction (a later migration) must
-- converge to the new values, not silently keep stale ones - `DO NOTHING`
-- would make a corrective seed migration a no-op on an already-seeded
-- database, defeating its own purpose.
--
-- DERIVED: every numeric value in every tier row below is derived
-- judgement, not measurement - revisit from `pacing_events` evidence after
-- a month of real traffic (see migration 0031's header for the full
-- ladder table and derivation notes).
--
-- CORRECTION (P14 fix round F3 finding 2/3, 2026-09-02): this file
-- previously seeded `per_recipient_24h = 1` on ALL THREE profiles, silently
-- reverting migration 0040 Part 6's correction wherever this file runs.
-- `db/tests/pacing-schema.test.ts`'s
-- `pins_the_deliberate_seeded_content_guard_thresholds_per_profile` pins the
-- values below exactly - `conservative=1, safe_default=3, steady=3` for
-- `per_recipient_24h`; `per_recipient_7d=3` and `dup_fanout_warn=30`/
-- `dup_fanout_ack=60` for `safe_default`/`steady` (`conservative` stays
-- stricter at 20/40, its own deliberate ~0.6x scaling, untouched by this
-- correction). Separately, migration 0040's own Part 5 header states FALSE
-- canon values (`per_recipient_7d=8`, `dup_fanout_warn=150`,
-- `dup_fanout_ack=500`, citing a migration-0030 CREATE TABLE comment that
-- does not exist) - 150/500/8 were the design's illustrative defaults only;
-- the platform's seeded values here are DELIBERATELY stricter. 0040 is
-- APPLIED and forward-only, so that header is never edited - this note and
-- the pinning test above are the guard against a future "restoring canon"
-- edit loosening these thresholds.

BEGIN;

INSERT INTO pacing_profiles (
  key, name, is_system, daily_cap_ceiling, gap_min_floor_ms,
  window_start_local, window_end_local, cold_ratio_max, cold_ratio_floor,
  per_recipient_24h, per_recipient_7d, dup_fanout_warn, dup_fanout_ack,
  hourly_cap_ceiling
) VALUES
  ('conservative', 'Conservative', true, 600, 20000, '08:00', '20:00', 0.50, 3, 1, 3, 20, 40, 50),
  ('safe_default', 'Safe Default', true, 1000, 15000, '08:00', '20:00', 0.80, 5, 3, 3, 30, 60, 80),
  ('steady', 'Steady', true, 1000, 10000, '08:00', '20:00', 0.80, 5, 3, 3, 30, 60, 80)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  is_system = EXCLUDED.is_system,
  daily_cap_ceiling = EXCLUDED.daily_cap_ceiling,
  gap_min_floor_ms = EXCLUDED.gap_min_floor_ms,
  window_start_local = EXCLUDED.window_start_local,
  window_end_local = EXCLUDED.window_end_local,
  cold_ratio_max = EXCLUDED.cold_ratio_max,
  cold_ratio_floor = EXCLUDED.cold_ratio_floor,
  per_recipient_24h = EXCLUDED.per_recipient_24h,
  per_recipient_7d = EXCLUDED.per_recipient_7d,
  dup_fanout_warn = EXCLUDED.dup_fanout_warn,
  dup_fanout_ack = EXCLUDED.dup_fanout_ack,
  hourly_cap_ceiling = EXCLUDED.hourly_cap_ceiling;

-- safe_default: the canonical six-tier ladder, verbatim from the phase
-- dispatch. See migration 0031's header for the full table in prose form.
INSERT INTO pacing_warmup_tiers (
  profile_key, tier, day_from, day_to, daily_cap, hourly_cap, new_conv_cap,
  gap_min_ms, gap_max_ms, cold_ratio_max, block_link_first_message,
  block_group_actions, group_daily_cap
) VALUES
  ('safe_default', 1, 1, 2, 20, 6, 8, 45000, 180000, 0.40, true, true, 0),
  ('safe_default', 2, 3, 7, 50, 12, 15, 40000, 150000, 0.50, true, true, 0),
  ('safe_default', 3, 8, 14, 150, 25, 40, 30000, 120000, 0.60, true, true, 0),
  ('safe_default', 4, 15, 21, 300, 45, 80, 25000, 90000, 0.70, false, false, 10),
  ('safe_default', 5, 22, 29, 450, 60, 110, 20000, 75000, 0.75, false, false, 20),
  ('safe_default', 6, 30, NULL, 600, 80, 150, 15000, 60000, 0.80, false, false, 30)
ON CONFLICT (profile_key, tier) DO UPDATE SET
  day_from = EXCLUDED.day_from, day_to = EXCLUDED.day_to,
  daily_cap = EXCLUDED.daily_cap, hourly_cap = EXCLUDED.hourly_cap,
  new_conv_cap = EXCLUDED.new_conv_cap, gap_min_ms = EXCLUDED.gap_min_ms,
  gap_max_ms = EXCLUDED.gap_max_ms, cold_ratio_max = EXCLUDED.cold_ratio_max,
  block_link_first_message = EXCLUDED.block_link_first_message,
  block_group_actions = EXCLUDED.block_group_actions,
  group_daily_cap = EXCLUDED.group_daily_cap;

-- conservative: DERIVED the same way as steady below - strictly tighter
-- than safe_default at EVERY tier (roughly 0.6x the caps, longer gaps,
-- lower cold_ratio_max, ceiling 600 not 1000).
INSERT INTO pacing_warmup_tiers (
  profile_key, tier, day_from, day_to, daily_cap, hourly_cap, new_conv_cap,
  gap_min_ms, gap_max_ms, cold_ratio_max, block_link_first_message,
  block_group_actions, group_daily_cap
) VALUES
  ('conservative', 1, 1, 2, 12, 4, 5, 60000, 220000, 0.30, true, true, 0),
  ('conservative', 2, 3, 7, 30, 8, 9, 55000, 190000, 0.35, true, true, 0),
  ('conservative', 3, 8, 14, 90, 15, 24, 40000, 150000, 0.45, true, true, 0),
  ('conservative', 4, 15, 21, 180, 27, 48, 32000, 110000, 0.55, false, false, 5),
  ('conservative', 5, 22, 29, 270, 36, 66, 26000, 95000, 0.60, false, false, 10),
  ('conservative', 6, 30, NULL, 360, 48, 90, 20000, 75000, 0.65, false, false, 15)
ON CONFLICT (profile_key, tier) DO UPDATE SET
  day_from = EXCLUDED.day_from, day_to = EXCLUDED.day_to,
  daily_cap = EXCLUDED.daily_cap, hourly_cap = EXCLUDED.hourly_cap,
  new_conv_cap = EXCLUDED.new_conv_cap, gap_min_ms = EXCLUDED.gap_min_ms,
  gap_max_ms = EXCLUDED.gap_max_ms, cold_ratio_max = EXCLUDED.cold_ratio_max,
  block_link_first_message = EXCLUDED.block_link_first_message,
  block_group_actions = EXCLUDED.block_group_actions,
  group_daily_cap = EXCLUDED.group_daily_cap;

-- steady: DERIVED as "no looser than safe_default's ceiling" - identical
-- per-tier caps to safe_default (never exceeding its 1000 ceiling) but
-- shorter gaps (a faster cadence within the same cap envelope, hence the
-- name: a steadier/tighter-spaced send rhythm reaching the same daily
-- volume sooner in the day, not a higher daily volume).
INSERT INTO pacing_warmup_tiers (
  profile_key, tier, day_from, day_to, daily_cap, hourly_cap, new_conv_cap,
  gap_min_ms, gap_max_ms, cold_ratio_max, block_link_first_message,
  block_group_actions, group_daily_cap
) VALUES
  ('steady', 1, 1, 2, 20, 6, 8, 35000, 140000, 0.40, true, true, 0),
  ('steady', 2, 3, 7, 50, 12, 15, 30000, 120000, 0.50, true, true, 0),
  ('steady', 3, 8, 14, 150, 25, 40, 22000, 95000, 0.60, true, true, 0),
  ('steady', 4, 15, 21, 300, 45, 80, 18000, 70000, 0.70, false, false, 10),
  ('steady', 5, 22, 29, 450, 60, 110, 15000, 60000, 0.75, false, false, 20),
  ('steady', 6, 30, NULL, 600, 80, 150, 10000, 45000, 0.80, false, false, 30)
ON CONFLICT (profile_key, tier) DO UPDATE SET
  day_from = EXCLUDED.day_from, day_to = EXCLUDED.day_to,
  daily_cap = EXCLUDED.daily_cap, hourly_cap = EXCLUDED.hourly_cap,
  new_conv_cap = EXCLUDED.new_conv_cap, gap_min_ms = EXCLUDED.gap_min_ms,
  gap_max_ms = EXCLUDED.gap_max_ms, cold_ratio_max = EXCLUDED.cold_ratio_max,
  block_link_first_message = EXCLUDED.block_link_first_message,
  block_group_actions = EXCLUDED.block_group_actions,
  group_daily_cap = EXCLUDED.group_daily_cap;

COMMIT;
