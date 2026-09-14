-- P13 C1 review, Finding 6 fix - migration 0033.
-- Forward-only, additive-only. Four new CHECK constraints on
-- `instance_pacing_state`, zero columns added/dropped/retyped, zero data
-- rewritten, no REVOKE anywhere in this file.
--
-- THE BUG: the absolute safety floors (`packages/domain/src/pacing/
-- constants.ts` - ABSOLUTE_GAP_MIN_MS, ABSOLUTE_DAILY_CEILING,
-- ABSOLUTE_GROUP_DAILY_CEILING) existed ONLY in TypeScript, enforced by a
-- single function (`resolveEffective()`) that every WRITER of `eff_*` is
-- merely expected to call. `db/queries/reserve-pacing.sql` reads `eff_*`
-- IN-STATEMENT and trusts it absolutely with no re-check of its own - so
-- the floor held only for writes that happened to go through
-- `updatePacingConfig`. A migration, support script, future writer, or
-- config-service bug setting `eff_gap_min_ms = 1` directly would silently
-- widen the send rate below the platform's own documented safety floor,
-- with NO structural stop anywhere in the database. Not hypothetical: this
-- migration's own companion test-fixture fix
-- (`app/backend/src/engine/queue/__tests__/queue-send-tenant-fixture.ts`)
-- found exactly this shape already seeded in a test fixture
-- (`eff_gap_min_ms = 1` vs the 15000 floor, `eff_daily_cap = 100000` vs the
-- 2000 ceiling, `eff_group_daily_cap = 100000` vs the 50 ceiling).
--
-- Core invariant 6 ("no provider-evasion mechanism, ever") requires there
-- be NO PATH that lowers the gap below the floor - structural, not one
-- TypeScript function one caller might forget to call. These four CHECKs
-- make every one of the four floors/ceilings a property of the ROW itself,
-- enforced by Postgres on every INSERT/UPDATE from EVERY role, mirroring
-- `packages/domain/src/pacing/constants.ts` exactly (named in each
-- constraint's own comment below, so the two stay traceable to each
-- other - see that file's own header for why the two must agree).
--
-- `eff_hourly_cap`/`eff_new_conv_cap`/`eff_cold_ratio_*` have no
-- `ABSOLUTE_*` constant in `constants.ts` today (only gap/daily/group are
-- named there) - no CHECK is added for those columns here; adding one
-- without a canonical constant to cite would be inventing a floor this
-- migration has no authority to set.
ALTER TABLE instance_pacing_state
  ADD CONSTRAINT instance_pacing_state_eff_gap_min_ms_floor
    CHECK (eff_gap_min_ms >= 15000),  -- packages/domain/src/pacing/constants.ts#ABSOLUTE_GAP_MIN_MS
  ADD CONSTRAINT instance_pacing_state_eff_gap_max_ms_order
    CHECK (eff_gap_max_ms >= eff_gap_min_ms),
  ADD CONSTRAINT instance_pacing_state_eff_daily_cap_ceiling
    CHECK (eff_daily_cap BETWEEN 0 AND 2000),  -- packages/domain/src/pacing/constants.ts#ABSOLUTE_DAILY_CEILING
  ADD CONSTRAINT instance_pacing_state_eff_group_daily_cap_ceiling
    CHECK (eff_group_daily_cap BETWEEN 0 AND 50);  -- packages/domain/src/pacing/constants.ts#ABSOLUTE_GROUP_DAILY_CEILING
