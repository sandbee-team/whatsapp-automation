-- P13a re-review (finding 4) - `wp_warmup_scan_due` (migration 0034)
-- projected `warmup_tier_since`, `config_version` and ten `eff_*` columns
-- that `runOnePacingEvaluatorSweep`/`evaluateOneInstance`
-- (app/backend/src/engine/pacing/warmup-evaluator.ts) never reads: the
-- evaluator only consumes `instance_id`, `client_id`, `pacing_timezone`,
-- `warmup_tier`, `warmup_started_at`, `health_band` and `health_state` from
-- each scanned row (`DueInstanceRow`'s post-trim shape, warmup-evaluator-
-- row.ts). The dropped columns were carried over from `instance_pacing_
-- state`'s full row shape without being narrowed to what this one caller
-- needs - the same "project only what the caller reads" discipline this
-- schema already applies to `wp_reconcile_scan_unresolved`'s own projection.
--
-- Additive-only in effect (a narrower SELECT list), but a `RETURNS TABLE`
-- column-set change requires `DROP FUNCTION` before `CREATE FUNCTION` -
-- Postgres has no in-place "drop a column from a set-returning function"
-- form (unlike `CREATE OR REPLACE FUNCTION`, which only permits the same
-- return type, appending trailing OUT columns, or an unchanged column list).
-- `DROP FUNCTION` on a still-referenced object is otherwise safe here: no
-- view/rule/other function/trigger depends on `wp_warmup_scan_due` (verified
-- via `pg_depend` before writing this migration - its only caller is
-- `runOnePacingEvaluatorSweep`'s own `SELECT * FROM wp_warmup_scan_due($1)`,
-- app-side, not a DB-side dependency), so the DROP cannot cascade into
-- anything else.
--
-- Ownership, search_path pin, PUBLIC revoke and the wp_scheduler EXECUTE
-- grant are NOT preserved automatically by DROP+CREATE (unlike CREATE OR
-- REPLACE, which does preserve them) - every one of them is re-stated below,
-- identical to migration 0034's original statements, so the function's
-- final state is identical to before this migration minus the ten unused
-- output columns. No table column added/dropped/retyped, no existing grant
-- on any TABLE widened or narrowed, no other function touched. Bumps schema
-- version from 34 to 35.

DROP FUNCTION public.wp_warmup_scan_due(int);

CREATE FUNCTION public.wp_warmup_scan_due(p_limit int)
RETURNS TABLE (
  instance_id       uuid,
  client_id         uuid,
  pacing_timezone   text,
  warmup_tier       smallint,
  warmup_started_at timestamptz,
  health_band       text,
  health_state      text
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
         s.health_band, i.health_state::text
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
