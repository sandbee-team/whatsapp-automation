-- P13 (pacing-and-warmup) Unit U1 - migration 0031.
-- Forward-only, additive-only. Seeds the three system pacing profiles
-- (`conservative` / `safe_default` [the default] / `steady`) and their
-- warm-up ladders into the tables migration 0030 created. No ALTER, no
-- DELETE, no table created here.
--
-- Statements are DUPLICATED verbatim from `db/seeds/pacing-profiles.sql`
-- rather than `\i`-included: the migration runner (db/src/migrate.ts) sends
-- migration files as raw SQL text through a plain `pg.Client` - `\i` is a
-- psql meta-command with no meaning there. See that seed file's own header
-- for the full rationale; keep the two files in sync by hand.
--
-- IDEMPOTENT via `ON CONFLICT ... DO UPDATE` (not `DO NOTHING`): re-running
-- an already-applied migration is a documented no-op per SESSION-PROTOCOL,
-- but a FUTURE corrective seed migration for this same catalog data must
-- converge existing rows to new values rather than silently no-op against
-- an already-seeded row - `DO NOTHING` would defeat that.
--
-- `daily_cap_ceiling` for `safe_default` is 1,000. `ABSOLUTE_DAILY_CEILING`
-- is 2,000 (hardcoded as a literal in db/tests/pacing-schema.test.ts,
-- pointing at packages/domain/src/pacing/constants.ts - U2's file, does not
-- exist yet) and no tier, override or admin relax may ever exceed it. Group
-- ceiling is 50 even for admin relax (enforced by U2's domain layer, not by
-- a DB CHECK constraint here - the ceiling is a cross-table invariant over
-- profile + tier + override, which a single-table CHECK cannot express).
--
-- THE SIX-TIER `safe_default` LADDER (DERIVED - every number below is
-- derived judgement, not measurement; revisit from real `pacing_events`
-- evidence after a month of live traffic):
--
-- | tier | day_from | day_to | daily_cap | hourly_cap | new_conv_cap | gap_min_ms | gap_max_ms | cold_ratio_max | group_daily_cap | block_link_first | block_group_actions |
-- |------|----------|--------|-----------|------------|--------------|------------|------------|-----------------|------------------|-------------------|----------------------|
-- |    1 |        1 |      2 |        20 |          6 |            8 |      45000 |     180000 |            0.40 |                0 | true              | true                 |
-- |    2 |        3 |      7 |        50 |         12 |           15 |      40000 |     150000 |            0.50 |                0 | true              | true                 |
-- |    3 |        8 |     14 |       150 |         25 |           40 |      30000 |     120000 |            0.60 |                0 | true              | true                 |
-- |    4 |       15 |     21 |       300 |         45 |           80 |      25000 |      90000 |            0.70 |               10 | false             | false                |
-- |    5 |       22 |     29 |       450 |         60 |          110 |      20000 |      75000 |            0.75 |               20 | false             | false                |
-- |    6 |       30 |   NULL |       600 |         80 |          150 |      15000 |      60000 |            0.80 |               30 | false             | false                |
--
-- `conservative` and `steady` are ALSO DERIVED (same "judgement not
-- measurement" caveat) - `conservative`'s every tier is strictly tighter
-- than `safe_default`'s corresponding tier (lower caps, longer gaps, lower
-- cold_ratio_max, 600 ceiling vs 1,000); `steady`'s daily/hourly/new-conv
-- caps and ceiling are IDENTICAL to `safe_default`'s (never looser - a
-- higher cap would breach "no looser than safe_default's ceiling"), with
-- shorter gap_min_ms/gap_max_ms only - a steadier send cadence within the
-- same volume envelope, not a higher one. See
-- `db/seeds/pacing-profiles.sql` for the exact per-profile values.

BEGIN;

INSERT INTO pacing_profiles (
  key, name, is_system, daily_cap_ceiling, gap_min_floor_ms,
  window_start_local, window_end_local, cold_ratio_max, cold_ratio_floor,
  per_recipient_24h, per_recipient_7d, dup_fanout_warn, dup_fanout_ack,
  hourly_cap_ceiling
) VALUES
  ('conservative', 'Conservative', true, 600, 20000, '08:00', '20:00', 0.50, 3, 1, 3, 20, 40, 50),
  ('safe_default', 'Safe Default', true, 1000, 15000, '08:00', '20:00', 0.80, 5, 1, 3, 30, 60, 80),
  ('steady', 'Steady', true, 1000, 10000, '08:00', '20:00', 0.80, 5, 1, 3, 30, 60, 80)
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
