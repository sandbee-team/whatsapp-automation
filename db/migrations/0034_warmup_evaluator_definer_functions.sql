-- P13a (warmup-ladder) FIX ROUND (C1/test-engineer review) - migration 0034.
-- Forward-only, additive-only: two new SECURITY DEFINER functions, one new
-- NOLOGIN/BYPASSRLS role (`wp_warmup`), narrow EXECUTE grants. No column
-- added/dropped/retyped, no existing policy altered/dropped, no BYPASSRLS
-- granted to wp_scheduler, no widening of wp_scheduler's existing SELECT-only
-- grant on instance_pacing_state.
--
-- THE BLOCKER (CRITICAL 1): `runOnePacingEvaluatorSweep` (engine/pacing/
-- warmup-evaluator.ts) runs its cross-tenant due-instance scan AND every
-- per-instance read/write on `deps.pool` (a raw pool/connection with no
-- `app.client_id` GUC set). `instance_pacing_state`, `pacing_events`,
-- `instance_pacing_overrides` and `audit_logs` are all ENABLE+FORCE RLS
-- (migrations 0030/0013), and the production cron role (whatever login role
-- `DATABASE_URL` resolves to in a real deployment - see this migration's own
-- "ROLE VERIFIED LIVE" note below) is `wp_scheduler`-equivalent: NOT
-- BYPASSRLS (`db/schema/grants.snapshot.json` pins `wp_scheduler.rolbypassrls
-- = false`), so a bare cross-tenant SELECT against any of those tables under
-- that role returns ZERO rows - the exact "wp_scheduler is not BYPASSRLS and
-- sees zero rows on a bare cross-tenant SELECT against FORCE-RLS" defect
-- already fixed once for the reaper/reconciler (migration 0027's own header,
-- restated verbatim in scripts/registries/cross-tenant-queries.ts:70).
-- `instance_pacing_state` additionally grants wp_scheduler SELECT-only
-- (migration 0030's deliberate "narrow the writer" protection: only the
-- config service, running as wp_app, may rewrite `eff_*`/`warmup_tier`) - so
-- even WITH a tenant GUC set, the evaluator's own UPDATE would fail under
-- wp_scheduler's grants alone. Both problems are solved the same way this
-- schema already solves them: SECURITY DEFINER functions, never a broadened
-- table-level grant to the scheduler role.
--
-- ROLE VERIFIED LIVE (this session, dev database): `roles/cron.ts` builds its
-- pool straight from `DATABASE_URL` with no `SET ROLE` anywhere in that file
-- or in `engine/cron/cron-wiring.ts` - identical shape to `roles/session-
-- worker.ts`, whose own send-loop wiring comment (`engine/queue/send-loop-
-- worker-wiring.ts:86`) states outright that `wp_scheduler` is "the
-- production role, not a RLS-bypassing superuser", and whose own RLS-proof
-- integration suite (`send-loop-worker-wiring.rls.integration.test.ts`) must
-- reach for `SET LOCAL ROLE wp_scheduler` explicitly BECAUSE the dev/test
-- pool's own login role (`wp`, `POSTGRES_USER` in `infra/compose/docker-
-- compose.dev.yml`) is cluster SUPERUSER + BYPASSRLS in this environment
-- (confirmed live: `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE
-- rolname = 'wp'` -> `true, true`) and therefore masks this exact class of
-- bug locally. In a real deployment `DATABASE_URL`'s login role is intended
-- to BE `wp_scheduler` (cron)/`wp_app` (session-worker/api) directly - see
-- `db/migrations/0005_rls_roles_and_grants.sql`'s own header ("production
-- LOGIN configuration ... is an ops concern, not schema"). Both `roles/
-- cron.ts` and `roles/session-worker.ts` therefore correctly call `deps.pool.
-- query(...)`/`tenantDb.withTenant(...)` with NO explicit role-switch - the
-- fix below follows that same shape: the SECURITY DEFINER functions are
-- callable by a bare `wp_scheduler`-authenticated connection with zero
-- additional ceremony, exactly like `wp_reap_expired_leases`/
-- `wp_reconcile_scan_unresolved` already are.
--
-- FIX SHAPE (mirrors migration 0027 exactly, same two-function split by
-- read/write concern):
--
--   1. `wp_warmup_scan_due(p_limit int)` - STABLE, read-only cross-tenant
--      scan of `instance_pacing_state` JOIN `whatsapp_instances`, `ORDER BY
--      random() LIMIT p_limit` (MAJOR 5: fixes fleet starvation - a fixed
--      `ORDER BY s.instance_id`/insertion-order scan would let the same
--      low-cardinality prefix of instances monopolise every tick once the
--      fleet exceeds `p_limit`; `random()` gives every due instance an equal
--      chance per tick, same fairness property `wp_lease_scan_unowned`
--      already established for discovery). Owned by `wp_admin_app`
--      (BYPASSRLS) - the ORIGINAL read-only precedent shape, no new role
--      needed for a function that only ever SELECTs (identical reasoning to
--      `wp_reconcile_scan_unresolved`'s own header). Projects exactly the
--      columns `runOnePacingEvaluatorSweep`/`readSystemProfileLayer` need
--      (this migration does not touch `pacing_profiles`/`readSystemProfile
--      Layer`'s own JOIN - that query still runs per-instance under
--      `tenantDb.withTenant`, see below - profile keys are a global catalog
--      with no RLS, so no definer function is needed there).
--
--   2. `wp_warmup_apply_tier_change(...)` - VOLATILE (writes), the ENTIRE
--      guarded transition in ONE atomic statement sequence: the tier-guarded
--      `instance_pacing_state` UPDATE (`WHERE instance_id = ... AND
--      client_id = ... AND warmup_tier = p_expected_from_tier`, exactly
--      config-service-warmup-write.ts's existing guard, unchanged), THEN
--      (only if the guard matched) an `audit_logs` INSERT and a
--      `pacing_events` INSERT (kind derived from `p_to_tier > p_expected_
--      from_tier` server-side, never trusted from the caller - same
--      "direction is derived, never passed in separately" discipline
--      `insertWarmupTierEvent` already applies). All in the SAME
--      `plpgsql` function body, which Postgres already runs as one implicit
--      transaction - this is what makes the transition atomic BY
--      CONSTRUCTION (CRITICAL 2: no more three autocommitted statements on a
--      bare pool). Returns `matched boolean` (false = race lost, zero rows
--      touched anywhere - the guard is checked FIRST and the function
--      returns immediately on a miss, before either insert) plus the fresh
--      `config_version`.
--
--      Cannot be owned by `wp_admin_app` (BYPASSRLS, but its own migration-
--      0030 grant on `instance_pacing_state` is SELECT-only, and widening it
--      to UPDATE would contradict every prior migration's "wp_admin_app:
--      SELECT-only everywhere" convention and this table's own deliberate
--      wp_scheduler-cannot-write protection this fix must NOT touch). A
--      FOURTH role dedicated to this one function, `wp_warmup` (NOLOGIN,
--      BYPASSRLS, granted UPDATE on exactly the `instance_pacing_state`
--      columns the transition writes plus INSERT on `audit_logs`/
--      `pacing_events`, nothing else) - same "fifth role, narrowly scoped,
--      NOLOGIN so it can never be a session identity" shape migration 0027
--      established for `wp_reaper`. EXECUTE granted to `wp_scheduler` only
--      (the cron loop's own role) - `wp_app` does NOT need it: `config-
--      service.ts`'s `updatePacingConfig({kind:'warmup_tier'})` now ROUTES
--      THROUGH this function too (see the companion TS change), and every
--      production caller of that path is the cron evaluator, running as
--      wp_scheduler. If a future wp_app-side caller needs a warmup_tier
--      change, EXECUTE can be widened then, deliberately, in its own
--      migration - not spelled out here speculatively.
--
--   Per-instance reads inside `evaluateOneInstance` (`hasRecentHardSignal`,
--   `isDegradedRollbackDue` on `pacing_events`; `readSystemProfileLayer`'s
--   `pacing_profiles` JOIN) move to `tenantDb.withTenant(clientId, ...)` in
--   the companion TS change (`warmup-evaluator.ts`) - `wp_scheduler` already
--   holds SELECT on `pacing_events`/`pacing_profiles`/`instance_pacing_
--   state` (migration 0030), so once `app.client_id` is set correctly by
--   `withTenant`, RLS admits exactly that tenant's rows. No new grant is
--   needed for these reads - only the GUC was missing.
--
-- Neither function ever branches on WHICH tenant a row belongs to (no
-- tenant-conditional logic anywhere in either body) - same placement-
-- neutrality property `wp_reap_expired_leases`'s own header documents.
-- Neither function's parameters, return columns, or body reference a phone
-- number, JID, or message body - ids, timestamps, tier numbers and jsonb
-- evidence blobs only (`evidence`/`reason_codes` are caller-supplied,
-- opaque, and already the shape `insertWarmupTierEvent` wrote before this
-- migration - unchanged).

-- ---------------------------------------------------------------------
-- 0. wp_warmup role (cluster-level, idempotent create - mirrors migration
--    0027's wp_reaper DO block exactly).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wp_warmup') THEN
    CREATE ROLE wp_warmup NOLOGIN;
  END IF;
END;
$$;

ALTER ROLE wp_warmup BYPASSRLS;

GRANT USAGE ON SCHEMA public TO wp_warmup;

-- Narrowest grant that makes wp_warmup_apply_tier_change's actual statements
-- work - derived directly from that function's body below.
-- eff_window_start_local/eff_window_end_local need SELECT too: the
-- function's own UPDATE reads their CURRENT value inside a COALESCE (a
-- caller may omit either window bound and keep the existing one) - the
-- first live test run against this migration surfaced the omission
-- ("permission denied for table instance_pacing_state" on that exact
-- UPDATE, confirmed by running the isolated statement live before/after
-- adding these two columns here).
GRANT SELECT (
  instance_id, client_id, warmup_tier, config_version,
  eff_window_start_local, eff_window_end_local
) ON instance_pacing_state TO wp_warmup;

GRANT UPDATE (
  eff_daily_cap, eff_hourly_cap, eff_new_conv_cap, eff_gap_min_ms, eff_gap_max_ms,
  eff_cold_ratio_max, eff_cold_ratio_floor, eff_window_start_local, eff_window_end_local,
  eff_group_daily_cap, config_version, updated_at, warmup_tier, warmup_tier_since
) ON instance_pacing_state TO wp_warmup;

GRANT INSERT ON audit_logs TO wp_warmup;
GRANT INSERT ON pacing_events TO wp_warmup;

-- ---------------------------------------------------------------------
-- 1. wp_warmup_scan_due(p_limit int) - STABLE, read-only. Owned by
--    wp_admin_app (original read-only precedent), EXECUTE to wp_scheduler.
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_warmup_scan_due(p_limit int)
RETURNS TABLE (
  instance_id             uuid,
  client_id               uuid,
  pacing_timezone         text,
  warmup_tier             smallint,
  warmup_started_at       timestamptz,
  warmup_tier_since       timestamptz,
  health_band             text,
  health_state            text,
  config_version          int,
  eff_daily_cap           int,
  eff_hourly_cap          int,
  eff_new_conv_cap        int,
  eff_gap_min_ms          int,
  eff_gap_max_ms          int,
  eff_cold_ratio_max      numeric,
  eff_cold_ratio_floor    int,
  eff_window_start_local  time,
  eff_window_end_local    time,
  eff_group_daily_cap     int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'wp_warmup_scan_due: p_limit must be between 1 and 5000, got %', p_limit;
  END IF;

  RETURN QUERY
  SELECT s.instance_id, s.client_id, s.pacing_timezone, s.warmup_tier, s.warmup_started_at,
         s.warmup_tier_since, s.health_band, i.health_state::text, s.config_version,
         s.eff_daily_cap, s.eff_hourly_cap, s.eff_new_conv_cap, s.eff_gap_min_ms, s.eff_gap_max_ms,
         s.eff_cold_ratio_max, s.eff_cold_ratio_floor, s.eff_window_start_local,
         s.eff_window_end_local, s.eff_group_daily_cap
    FROM public.instance_pacing_state s
    JOIN public.whatsapp_instances i ON i.id = s.instance_id
   WHERE i.deleted_at IS NULL
   ORDER BY random()
   LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.wp_warmup_scan_due(int) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_warmup_scan_due(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_warmup_scan_due(int) TO wp_scheduler;

-- ---------------------------------------------------------------------
-- 2. wp_warmup_apply_tier_change(...) - VOLATILE, the entire guarded
--    transition in one definer-function body (one implicit transaction).
--    Owned by wp_warmup (NOLOGIN, BYPASSRLS - see header). EXECUTE to
--    wp_scheduler only (see header for why wp_app is deliberately omitted).
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_warmup_apply_tier_change(
  p_instance_id           uuid,
  p_client_id             uuid,
  p_expected_from_tier    smallint,
  p_to_tier               smallint,
  p_eff_daily_cap         int,
  p_eff_hourly_cap        int,
  p_eff_new_conv_cap      int,
  p_eff_gap_min_ms        int,
  p_eff_gap_max_ms        int,
  p_eff_cold_ratio_max    numeric,
  p_eff_cold_ratio_floor  int,
  p_eff_window_start_local time,
  p_eff_window_end_local   time,
  p_eff_group_daily_cap    int,
  p_reason_codes           text[],
  p_evidence               jsonb,
  p_reason                 text,
  p_actor_user_id          uuid
)
RETURNS TABLE (
  matched             boolean,
  new_config_version  int
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event_kind   text;
  v_new_version  int;
  v_event_id     uuid;
BEGIN
  IF p_instance_id IS NULL OR p_client_id IS NULL THEN
    RAISE EXCEPTION 'wp_warmup_apply_tier_change: instance_id/client_id must not be null';
  END IF;

  -- The tier-guarded UPDATE - identical predicate/SET shape to
  -- config-service-warmup-write.ts's pre-fix updateWarmupTierEffRow, now
  -- run inside this function's own implicit transaction instead of on a
  -- bare autocommitted pool connection. Migration 0033's CHECK floors on
  -- instance_pacing_state still bind here unconditionally - this function
  -- grants no exemption from them. (The OUT parameter is named
  -- `new_config_version`, distinct from the `config_version` COLUMN, so
  -- this statement's own `config_version = config_version + 1` unambiguously
  -- resolves to the column in every plpgsql version - no qualification
  -- trick required.)
  UPDATE public.instance_pacing_state
     SET eff_daily_cap = p_eff_daily_cap,
         eff_hourly_cap = p_eff_hourly_cap,
         eff_new_conv_cap = p_eff_new_conv_cap,
         eff_gap_min_ms = p_eff_gap_min_ms,
         eff_gap_max_ms = p_eff_gap_max_ms,
         eff_cold_ratio_max = p_eff_cold_ratio_max,
         eff_cold_ratio_floor = p_eff_cold_ratio_floor,
         eff_window_start_local = COALESCE(p_eff_window_start_local, eff_window_start_local),
         eff_window_end_local = COALESCE(p_eff_window_end_local, eff_window_end_local),
         eff_group_daily_cap = p_eff_group_daily_cap,
         config_version = config_version + 1,
         updated_at = now(),
         warmup_tier = p_to_tier,
         warmup_tier_since = now()
   WHERE instance_id = p_instance_id AND client_id = p_client_id AND warmup_tier = p_expected_from_tier
  RETURNING instance_pacing_state.config_version INTO v_new_version;

  IF NOT FOUND THEN
    -- The guard missed (another tick already applied a change, or a stale
    -- caller) - clean no-op, no audit row, no event row. Matches
    -- WarmupTierRaceLostError's existing "a losing race writes nothing"
    -- contract exactly.
    RETURN QUERY SELECT false, NULL::int;
    RETURN;
  END IF;

  v_event_kind := CASE WHEN p_to_tier > p_expected_from_tier THEN 'WARMUP_ADVANCE' ELSE 'WARMUP_ROLLBACK' END;
  v_event_id := gen_random_uuid();

  INSERT INTO public.audit_logs (client_id, actor_type, actor_user_id, action, target_type, target_id, metadata)
  VALUES (
    p_client_id,
    CASE WHEN p_actor_user_id IS NULL THEN 'system' ELSE 'user' END,
    p_actor_user_id,
    'pacing.config.change',
    'instance',
    p_instance_id,
    jsonb_build_object(
      'field', 'warmup_tier',
      'reason', p_reason,
      'to', jsonb_build_object(
        'eff_daily_cap', p_eff_daily_cap, 'eff_hourly_cap', p_eff_hourly_cap,
        'eff_new_conv_cap', p_eff_new_conv_cap, 'eff_gap_min_ms', p_eff_gap_min_ms,
        'eff_gap_max_ms', p_eff_gap_max_ms, 'eff_cold_ratio_max', p_eff_cold_ratio_max,
        'eff_cold_ratio_floor', p_eff_cold_ratio_floor,
        'eff_window_start_local', p_eff_window_start_local,
        'eff_window_end_local', p_eff_window_end_local,
        'eff_group_daily_cap', p_eff_group_daily_cap
      )
    )
  );

  INSERT INTO public.pacing_events (id, client_id, instance_id, kind, from_value, to_value, reason_codes, evidence, actor_user_id)
  VALUES (
    v_event_id, p_client_id, p_instance_id, v_event_kind,
    jsonb_build_object('warmupTier', p_expected_from_tier),
    jsonb_build_object(
      'warmupTier', p_to_tier, 'eff_daily_cap', p_eff_daily_cap, 'eff_hourly_cap', p_eff_hourly_cap,
      'eff_new_conv_cap', p_eff_new_conv_cap, 'eff_gap_min_ms', p_eff_gap_min_ms,
      'eff_gap_max_ms', p_eff_gap_max_ms, 'eff_cold_ratio_max', p_eff_cold_ratio_max,
      'eff_cold_ratio_floor', p_eff_cold_ratio_floor,
      'eff_window_start_local', p_eff_window_start_local,
      'eff_window_end_local', p_eff_window_end_local,
      'eff_group_daily_cap', p_eff_group_daily_cap
    ),
    p_reason_codes,
    p_evidence,
    p_actor_user_id
  );

  RETURN QUERY SELECT true, v_new_version;
END;
$$;

ALTER FUNCTION public.wp_warmup_apply_tier_change(
  uuid, uuid, smallint, smallint, int, int, int, int, int, numeric, int, time, time, int,
  text[], jsonb, text, uuid
) OWNER TO wp_warmup;
REVOKE ALL ON FUNCTION public.wp_warmup_apply_tier_change(
  uuid, uuid, smallint, smallint, int, int, int, int, int, numeric, int, time, time, int,
  text[], jsonb, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_warmup_apply_tier_change(
  uuid, uuid, smallint, smallint, int, int, int, int, int, numeric, int, time, time, int,
  text[], jsonb, text, uuid
) TO wp_scheduler;
