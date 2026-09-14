-- P18 (wallet-ledger-and-pricing) Unit U8a - migration 0053.
--
-- Seven READ-ONLY, cross-tenant SECURITY DEFINER functions for the wallet
-- reconciler (checks A-E), its daily rollup compute, and the empty-client
-- gauge. Same idiom as migration 0027's `wp_reconcile_scan_unresolved`
-- (that migration's own header, copied verbatim below): `wp_scheduler` is
-- NOT BYPASSRLS and would see zero rows on a bare cross-tenant SELECT
-- against any FORCE-RLS table here (`wallet_accounts`, `wallet_ledger`,
-- `wallet_charge_guards`, `wallet_daily_summary`, `send_attempts`,
-- `message_jobs`), so each scan is wrapped in a function owned by
-- `wp_admin_app` (BYPASSRLS) with EXECUTE granted only to `wp_scheduler`.
--
-- LANGUAGE plpgsql (not `sql`) for the same reason as every prior definer
-- function in this schema: mandatory parameter validation needs `RAISE
-- EXCEPTION`, which `sql`-language functions cannot do. All seven are
-- `STABLE` - no table here is ever written by any of these functions. Every
-- WRITE the reconciler or rollup job makes (the corrective debit, the
-- rollup upsert, the finding insert) stays on the normal per-tenant RLS
-- path as `wp_app` (ADR 0038 SS6) - see `db/queries/wallet-reconcile.sql`.
--
-- Every table reference below is schema-qualified `public.` (this
-- migration's own `search_path` is pinned to `pg_catalog, public` per
-- function, but the qualification is kept explicit for the same
-- defence-in-depth reason migration 0027 gives).

-- ---------------------------------------------------------------------
-- 1. wp_wallet_check_continuity(p_limit int) - check A. Bounded per-client:
--    reads AT MOST 200 of the most recent `wallet_ledger` rows per client
--    (never the full ledger) plus that client's own `wallet_accounts`
--    checkpoint/balance columns. Detects three independent break shapes:
--    a sequence/balance discontinuity within the 200-row window, a break
--    anchored on the checkpoint boundary (the oldest row in the window),
--    and a balance/entry_seq mismatch against the account row itself.
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_wallet_check_continuity(p_limit int)
RETURNS TABLE (
  client_id    uuid,
  kind         text,
  detail       jsonb,
  amount_minor bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v RECORD;
  oldest RECORD;
  newest RECORD;
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'wp_wallet_check_continuity: p_limit must be between 1 and 5000, got %', p_limit;
  END IF;

  FOR v IN
    SELECT a.client_id, a.balance_minor, a.entry_seq, a.checkpoint_seq, a.checkpoint_balance_minor
      FROM public.wallet_accounts a
     ORDER BY a.client_id
     LIMIT p_limit
  LOOP
    -- Bounded per-client read: at most the 200 most recent ledger rows for
    -- THIS client. Never an aggregate over the full ledger (test-pinned:
    -- this function's body must never contain the token s-u-m openparen).
    FOR v IN
      SELECT o.seq, o.amount_minor, o.balance_after_minor, o.prev_seq, o.prev_bal
        FROM (
          SELECT seq, amount_minor, balance_after_minor,
                 lag(seq) OVER (ORDER BY seq) AS prev_seq,
                 lag(balance_after_minor) OVER (ORDER BY seq) AS prev_bal
            FROM (
              SELECT seq, amount_minor, balance_after_minor
                FROM public.wallet_ledger
               WHERE wallet_ledger.client_id = v.client_id
               ORDER BY seq DESC
               LIMIT 200
            ) recent
        ) o
       ORDER BY o.seq
    LOOP
      IF v.prev_seq IS NOT NULL
         AND (v.seq <> v.prev_seq + 1 OR v.balance_after_minor <> v.prev_bal + v.amount_minor)
      THEN
        client_id := v.client_id;
        kind := 'continuity_break';
        detail := jsonb_build_object(
          'seq', v.seq, 'prev_seq', v.prev_seq,
          'expected', v.prev_bal + v.amount_minor, 'actual', v.balance_after_minor
        );
        amount_minor := v.balance_after_minor - (v.prev_bal + v.amount_minor);
        RETURN NEXT;
      END IF;
    END LOOP;

    -- Re-read the bounded window's extremes (oldest/newest) once more for
    -- the checkpoint-anchored and balance/entry_seq checks below - a fresh
    -- bounded query, not an unbounded one.
    SELECT r.seq, r.amount_minor, r.balance_after_minor
      INTO oldest
      FROM (
        SELECT seq, amount_minor, balance_after_minor
          FROM public.wallet_ledger
         WHERE wallet_ledger.client_id = v.client_id
         ORDER BY seq ASC
         LIMIT 1
      ) r;

    SELECT r.seq, r.balance_after_minor
      INTO newest
      FROM (
        SELECT seq, balance_after_minor
          FROM public.wallet_ledger
         WHERE wallet_ledger.client_id = v.client_id
         ORDER BY seq DESC
         LIMIT 1
      ) r;

    IF oldest.seq IS NOT NULL AND v.checkpoint_seq > 0 AND oldest.seq = v.checkpoint_seq + 1 THEN
      IF oldest.balance_after_minor <> v.checkpoint_balance_minor + oldest.amount_minor THEN
        client_id := v.client_id;
        kind := 'continuity_break';
        detail := jsonb_build_object(
          'seq', oldest.seq, 'anchored_on', 'checkpoint',
          'expected', v.checkpoint_balance_minor + oldest.amount_minor, 'actual', oldest.balance_after_minor
        );
        amount_minor := oldest.balance_after_minor - (v.checkpoint_balance_minor + oldest.amount_minor);
        RETURN NEXT;
      END IF;
    END IF;

    IF newest.seq IS NOT NULL THEN
      IF newest.balance_after_minor <> v.balance_minor THEN
        client_id := v.client_id;
        kind := 'balance_mismatch';
        detail := jsonb_build_object(
          'ledger_balance', newest.balance_after_minor, 'account_balance', v.balance_minor,
          'max_seq', newest.seq, 'entry_seq', v.entry_seq
        );
        amount_minor := v.balance_minor - newest.balance_after_minor;
        RETURN NEXT;
      END IF;
    ELSE
      IF v.balance_minor <> v.checkpoint_balance_minor THEN
        client_id := v.client_id;
        kind := 'balance_mismatch';
        detail := jsonb_build_object(
          'ledger_balance', v.checkpoint_balance_minor, 'account_balance', v.balance_minor,
          'max_seq', v.checkpoint_seq, 'entry_seq', v.entry_seq
        );
        amount_minor := v.balance_minor - v.checkpoint_balance_minor;
        RETURN NEXT;
      END IF;
    END IF;

    IF v.entry_seq <> COALESCE(newest.seq, v.checkpoint_seq) THEN
      client_id := v.client_id;
      kind := 'continuity_break';
      detail := jsonb_build_object(
        'reason', 'entry_seq_drift', 'entry_seq', v.entry_seq,
        'max_seq', COALESCE(newest.seq, v.checkpoint_seq)
      );
      amount_minor := 0;
      RETURN NEXT;
    END IF;

    oldest := NULL;
    newest := NULL;
  END LOOP;
END;
$$;

ALTER FUNCTION public.wp_wallet_check_continuity(int) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_wallet_check_continuity(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_wallet_check_continuity(int) TO wp_scheduler;

-- ---------------------------------------------------------------------
-- 2. wp_wallet_check_missing_debits(p_from, p_to, p_limit) - check B.
--    Acked/reconciled_sent attempts resolved in [p_from, p_to) with no
--    matching debit_send/adjustment_debit guard row.
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_wallet_check_missing_debits(p_from timestamptz, p_to timestamptz, p_limit int)
RETURNS TABLE (
  client_id               uuid,
  send_attempt_id          bigint,
  message_job_id           bigint,
  message_job_created_at    timestamptz,
  instance_id              uuid,
  job_status               text,
  resolved_at               timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'wp_wallet_check_missing_debits: p_limit must be between 1 and 5000, got %', p_limit;
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION 'wp_wallet_check_missing_debits: p_from must be before p_to';
  END IF;

  RETURN QUERY
  SELECT a.client_id, a.id, j.id, j.created_at, j.instance_id, j.status::text, a.resolved_at
    FROM public.send_attempts a
    JOIN public.message_jobs j ON j.id = a.message_job_id AND j.created_at = a.message_job_created_at
   WHERE a.state IN ('acked', 'reconciled_sent')
     AND a.resolved_at >= p_from AND a.resolved_at < p_to
     AND a.message_job_created_at >= p_from - interval '2 days'
     AND NOT EXISTS (
       SELECT 1 FROM public.wallet_charge_guards g
        WHERE g.send_attempt_id = a.id AND g.kind IN ('debit_send', 'adjustment_debit')
          AND g.created_at = a.message_job_created_at
     )
   ORDER BY a.resolved_at, a.id
   LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.wp_wallet_check_missing_debits(timestamptz, timestamptz, int) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_wallet_check_missing_debits(timestamptz, timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_wallet_check_missing_debits(timestamptz, timestamptz, int) TO wp_scheduler;

-- ---------------------------------------------------------------------
-- 3. wp_wallet_check_orphan_debits(p_from, p_to, p_limit) - check C.
--    debit_send guards in [p_from, p_to) with no matching settled attempt.
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_wallet_check_orphan_debits(p_from timestamptz, p_to timestamptz, p_limit int)
RETURNS TABLE (
  client_id       uuid,
  send_attempt_id  bigint,
  ledger_seq       bigint,
  attempt_state    text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'wp_wallet_check_orphan_debits: p_limit must be between 1 and 5000, got %', p_limit;
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION 'wp_wallet_check_orphan_debits: p_from must be before p_to';
  END IF;

  RETURN QUERY
  SELECT g.client_id, g.send_attempt_id, g.ledger_seq, COALESCE(a.state::text, 'missing')
    FROM public.wallet_charge_guards g
    LEFT JOIN public.send_attempts a ON a.id = g.send_attempt_id
   WHERE g.kind = 'debit_send'
     AND g.created_at >= p_from - interval '2 days' AND g.created_at < p_to
     AND (a.id IS NULL OR a.state NOT IN ('acked', 'reconciled_sent'))
   ORDER BY g.created_at, g.send_attempt_id
   LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.wp_wallet_check_orphan_debits(timestamptz, timestamptz, int) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_wallet_check_orphan_debits(timestamptz, timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_wallet_check_orphan_debits(timestamptz, timestamptz, int) TO wp_scheduler;

-- ---------------------------------------------------------------------
-- 4. wp_wallet_rollup_compute(p_day, p_limit) - one UTC day of one monthly
--    `wallet_ledger` partition, grouped by (client_id, instance_id) - NOT a
--    full-ledger aggregate. `p_day::timestamp AT TIME ZONE 'UTC'` is UTC
--    midnight as timestamptz (never `p_day::timestamptz`, which would use
--    the session zone).
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_wallet_rollup_compute(p_day date, p_limit int)
RETURNS TABLE (
  client_id    uuid,
  instance_id   uuid,
  sent_count    int,
  debit_minor   bigint,
  credit_minor  bigint,
  refund_minor  bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'wp_wallet_rollup_compute: p_limit must be between 1 and 5000, got %', p_limit;
  END IF;
  IF p_day IS NULL THEN
    RAISE EXCEPTION 'wp_wallet_rollup_compute: p_day must not be null';
  END IF;

  RETURN QUERY
  SELECT l.client_id, l.instance_id,
         (count(*) FILTER (WHERE l.kind = 'debit_send'))::int,
         COALESCE(-sum(l.amount_minor) FILTER (WHERE l.kind IN ('debit_send', 'adjustment_debit')), 0)::bigint,
         COALESCE(sum(l.amount_minor) FILTER (
           WHERE l.kind IN ('signup_credit', 'topup_manual', 'topup_gateway', 'promo_credit', 'adjustment_credit')
         ), 0)::bigint,
         COALESCE(sum(l.amount_minor) FILTER (WHERE l.kind = 'refund_send'), 0)::bigint
    FROM public.wallet_ledger l
   WHERE l.created_at >= (p_day::timestamp AT TIME ZONE 'UTC')
     AND l.created_at < ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
     AND l.instance_id IS NOT NULL
   GROUP BY l.client_id, l.instance_id
   ORDER BY l.client_id, l.instance_id
   LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.wp_wallet_rollup_compute(date, int) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_wallet_rollup_compute(date, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_wallet_rollup_compute(date, int) TO wp_scheduler;

-- ---------------------------------------------------------------------
-- 5. wp_wallet_check_rollup_parity(p_day, p_limit) - check D. FULL OUTER
--    JOIN of the compute function (unbounded 5000 internally, capped by
--    p_limit on the OUTPUT) against the persisted `wallet_daily_summary`
--    row for that day, one row per differing field.
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_wallet_check_rollup_parity(p_day date, p_limit int)
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
  joined AS (
    SELECT
      COALESCE(c.client_id, s.client_id)   AS client_id,
      COALESCE(c.instance_id, s.instance_id) AS instance_id,
      COALESCE(c.sent_count, 0)   AS expected_sent_count,   s.sent_count   AS actual_sent_count,
      COALESCE(c.debit_minor, 0)  AS expected_debit_minor,  s.debit_minor  AS actual_debit_minor,
      COALESCE(c.credit_minor, 0) AS expected_credit_minor, s.credit_minor AS actual_credit_minor,
      COALESCE(c.refund_minor, 0) AS expected_refund_minor, s.refund_minor AS actual_refund_minor
    FROM computed c
    FULL OUTER JOIN public.wallet_daily_summary s
      ON s.client_id = c.client_id AND s.instance_id = c.instance_id AND s.day = p_day
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

-- ---------------------------------------------------------------------
-- 6. wp_wallet_check_orphan_guards(p_limit) - check E. Unstamped guards
--    (ledger_seq = 0) older than 10 minutes. `created_at` is the JOB's
--    created_at, so this is "job older than 10 minutes with an unstamped
--    guard" - under the one-transaction debit an orphan should be
--    impossible; this is the canary.
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_wallet_check_orphan_guards(p_limit int)
RETURNS TABLE (
  client_id       uuid,
  send_attempt_id  bigint,
  kind             wallet_entry_kind,
  created_at        timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'wp_wallet_check_orphan_guards: p_limit must be between 1 and 5000, got %', p_limit;
  END IF;

  RETURN QUERY
  SELECT g.client_id, g.send_attempt_id, g.kind, g.created_at
    FROM public.wallet_charge_guards g
   WHERE g.ledger_seq = 0 AND g.created_at < now() - interval '10 minutes'
   ORDER BY g.created_at, g.send_attempt_id
   LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.wp_wallet_check_orphan_guards(int) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_wallet_check_orphan_guards(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_wallet_check_orphan_guards(int) TO wp_scheduler;

-- ---------------------------------------------------------------------
-- 7. wp_wallet_count_empty_clients() - platform gauge, no parameters.
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_wallet_count_empty_clients()
RETURNS int
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*)::int INTO v_count FROM public.wallet_accounts WHERE state = 'empty';
  RETURN v_count;
END;
$$;

ALTER FUNCTION public.wp_wallet_count_empty_clients() OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_wallet_count_empty_clients() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_wallet_count_empty_clients() TO wp_scheduler;
