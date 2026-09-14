-- P18 fix-round (debugger) — migration 0056: `s.day = p_day` was a join
-- predicate, not a filter — `wp_wallet_check_rollup_parity` (migration 0053)
-- joined `computed` (already scoped to `p_day` via `wp_wallet_rollup_compute`)
-- against the FULL `wallet_daily_summary` table with `s.day = p_day` placed in
-- the FULL OUTER JOIN's ON clause instead of a WHERE/pre-filter. A FULL OUTER
-- JOIN's ON clause only controls MATCHING, never ELIMINATION: every
-- `wallet_daily_summary` row for a client/instance with history on more than
-- one day, whose `day <> p_day`, still satisfies "no match found" and
-- survives as an unmatched RIGHT-side row — reported as a spurious
-- `rollup_parity` finding (`expected 0`, `actual <that other day's value>`)
-- for every day queried, forever, for every client with more than one day of
-- rollup history. Proven by
-- `app/backend/src/modules/wallet/reconcile.integration.test.ts`'s
-- `a_missing_debit_is_detected_and_auto_corrected_once`: its second sweep
-- (idempotency check) re-reported a `rollup_parity` finding for the PRIOR
-- day's `debit_minor`, purely because that row now existed in
-- `wallet_daily_summary` from the first sweep's rollup run.
--
-- Fix: pre-filter `wallet_daily_summary` to `p_day` in its OWN CTE (`summary`)
-- BEFORE the FULL OUTER JOIN, so the ON clause only ever compares
-- (client_id, instance_id) — the same idiom `computed` already uses via
-- `wp_wallet_rollup_compute(p_day, ...)`. `CREATE OR REPLACE FUNCTION`
-- restates every attribute (signature, LANGUAGE plpgsql STABLE SECURITY
-- DEFINER SET search_path, parameter validation, RETURNS TABLE shape, owner,
-- REVOKE/GRANT) verbatim from migration 0053, per this schema's established
-- idiom for definer-function fixes (see migrations 0054/0055's own headers).
-- Every column below stays table/CTE-qualified (the 42702 lesson from the
-- SAME migration 0053 — see `.memory/lessons/2026-09-04-plpgsql-out-param-
-- shadows-column.md`).

CREATE OR REPLACE FUNCTION public.wp_wallet_check_rollup_parity(p_day date, p_limit int)
RETURNS TABLE (
  client_id    uuid,
  instance_id   uuid,
  field         text,
  expected      bigint,
  actual        bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'wp_wallet_check_rollup_parity: p_limit must be between 1 and 5000, got %', p_limit;
  END IF;
  IF p_day IS NULL THEN
    RAISE EXCEPTION 'wp_wallet_check_rollup_parity: p_day must not be null';
  END IF;

  RETURN QUERY
  WITH computed AS (
    SELECT * FROM public.wp_wallet_rollup_compute(p_day, 5000)
  ),
  summary AS (
    SELECT s.client_id, s.instance_id, s.sent_count, s.debit_minor, s.credit_minor, s.refund_minor
      FROM public.wallet_daily_summary s
     WHERE s.day = p_day
  ),
  joined AS (
    SELECT
      COALESCE(c.client_id, s.client_id)   AS client_id,
      COALESCE(c.instance_id, s.instance_id) AS instance_id,
      COALESCE(c.sent_count, 0)   AS expected_sent_count,   s.sent_count   AS actual_sent_count,
      COALESCE(c.debit_minor, 0)  AS expected_debit_minor,  s.debit_minor  AS actual_debit_minor,
      COALESCE(c.credit_minor, 0) AS expected_credit_minor, s.credit_minor AS actual_credit_minor,
      COALESCE(c.refund_minor, 0) AS expected_refund_minor, s.refund_minor AS actual_refund_minor
    FROM computed c
    FULL OUTER JOIN summary s
      ON s.client_id = c.client_id AND s.instance_id = c.instance_id
  )
  SELECT j.client_id, j.instance_id, 'sent_count', j.expected_sent_count::bigint, j.actual_sent_count::bigint
    FROM joined j WHERE j.actual_sent_count IS DISTINCT FROM j.expected_sent_count
  UNION ALL
  SELECT j.client_id, j.instance_id, 'debit_minor', j.expected_debit_minor, j.actual_debit_minor
    FROM joined j WHERE j.actual_debit_minor IS DISTINCT FROM j.expected_debit_minor
  UNION ALL
  SELECT j.client_id, j.instance_id, 'credit_minor', j.expected_credit_minor, j.actual_credit_minor
    FROM joined j WHERE j.actual_credit_minor IS DISTINCT FROM j.expected_credit_minor
  UNION ALL
  SELECT j.client_id, j.instance_id, 'refund_minor', j.expected_refund_minor, j.actual_refund_minor
    FROM joined j WHERE j.actual_refund_minor IS DISTINCT FROM j.expected_refund_minor
  ORDER BY 1, 2, 3
  LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.wp_wallet_check_rollup_parity(date, int) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_wallet_check_rollup_parity(date, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_wallet_check_rollup_parity(date, int) TO wp_scheduler;
