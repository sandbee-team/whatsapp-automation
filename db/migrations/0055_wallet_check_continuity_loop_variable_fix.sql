-- P18 fix-round (debugger) — migration 0055: 42703 "record \"v\" has no
-- field \"client_id\"" in wp_wallet_check_continuity, found by EXECUTING
-- migration 0054's fixed function against seeded data (never revealed by
-- `pg_get_functiondef` inspection, and not visible until 0054's own
-- ambiguous-column bug stopped masking it).
--
-- The outer `FOR v IN SELECT a.client_id, … FROM wallet_accounts a LOOP`
-- and the inner windowed-read `FOR v IN SELECT o.seq, o.amount_minor, … LOOP`
-- reused the SAME PL/pgSQL loop variable `v`. The instant the inner loop
-- produced at least one row, `v` was rebound to that row's (different)
-- record shape, so every later read of `v.client_id` / `v.checkpoint_seq` /
-- `v.checkpoint_balance_minor` / `v.balance_minor` / `v.entry_seq` for the
-- REST of that outer iteration raised `ERROR 42703: record "v" has no field
-- "client_id"`. Fix: give the inner loop its own variable (`w`), and update
-- every reference inside that inner loop body accordingly; the outer loop
-- keeps `v` throughout, unclobbered. No other behavior, signature, `LIMIT
-- 200`, or the no-`sum(` property changes.

CREATE OR REPLACE FUNCTION public.wp_wallet_check_continuity(p_limit int)
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
  w RECORD;
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
    -- Every column below is table-qualified (`recent.`/`o.`) so none can
    -- collide with the OUT parameter `amount_minor`. This inner loop uses
    -- its OWN variable `w` (never `v`, the outer loop's variable) - the
    -- 42703 fix this migration exists for.
    FOR w IN
      SELECT o.seq, o.amount_minor, o.balance_after_minor, o.prev_seq, o.prev_bal
        FROM (
          SELECT recent.seq, recent.amount_minor, recent.balance_after_minor,
                 lag(recent.seq) OVER (ORDER BY recent.seq) AS prev_seq,
                 lag(recent.balance_after_minor) OVER (ORDER BY recent.seq) AS prev_bal
            FROM (
              SELECT wallet_ledger.seq, wallet_ledger.amount_minor, wallet_ledger.balance_after_minor
                FROM public.wallet_ledger
               WHERE wallet_ledger.client_id = v.client_id
               ORDER BY wallet_ledger.seq DESC
               LIMIT 200
            ) recent
        ) o
       ORDER BY o.seq
    LOOP
      IF w.prev_seq IS NOT NULL
         AND (w.seq <> w.prev_seq + 1 OR w.balance_after_minor <> w.prev_bal + w.amount_minor)
      THEN
        client_id := v.client_id;
        kind := 'continuity_break';
        detail := jsonb_build_object(
          'seq', w.seq, 'prev_seq', w.prev_seq,
          'expected', w.prev_bal + w.amount_minor, 'actual', w.balance_after_minor
        );
        amount_minor := w.balance_after_minor - (w.prev_bal + w.amount_minor);
        RETURN NEXT;
      END IF;
    END LOOP;

    -- Re-read the bounded window's extremes (oldest/newest) once more for
    -- the checkpoint-anchored and balance/entry_seq checks below - a fresh
    -- bounded query, not an unbounded one. Table-qualified throughout.
    SELECT r.seq, r.amount_minor, r.balance_after_minor
      INTO oldest
      FROM (
        SELECT wallet_ledger.seq, wallet_ledger.amount_minor, wallet_ledger.balance_after_minor
          FROM public.wallet_ledger
         WHERE wallet_ledger.client_id = v.client_id
         ORDER BY wallet_ledger.seq ASC
         LIMIT 1
      ) r;

    SELECT r.seq, r.balance_after_minor
      INTO newest
      FROM (
        SELECT wallet_ledger.seq, wallet_ledger.balance_after_minor
          FROM public.wallet_ledger
         WHERE wallet_ledger.client_id = v.client_id
         ORDER BY wallet_ledger.seq DESC
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
